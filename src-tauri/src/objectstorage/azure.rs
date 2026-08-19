//! Azure Blob engine: raw HTTPS over the shared reqwest client + quick-xml,
//! with a hand-written Shared Key signer (the official SDK only supports Entra
//! ID natively). SAS auth appends the token to the URL instead of signing.
//! Verified against Azurite. Mirrors the S3 client's operation surface so the
//! command layer can dispatch on `OssHandle` uniformly.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use base64::Engine as _;
use hmac::{Hmac, KeyInit, Mac};
use reqwest::Client;
use serde::Deserialize;
use sha2::Sha256;
use tauri::{AppHandle, Runtime};
use url::Url;

use super::types::{BucketEntry, ObjectEntry, ObjectListPage, ObjectMetadata};
use crate::filebrowser::transfer::TransferHandle;

type HmacSha256 = Hmac<Sha256>;

const MS_VERSION: &str = "2021-12-02";

/// How a request is authorized.
pub enum AzureAuth {
    /// Shared Key: the decoded (raw) account key, HMAC-signed per request.
    SharedKey(Vec<u8>),
    /// A SAS token (query string, without the leading '?') appended to the URL.
    Sas(String),
    /// An Entra ID (Azure AD) OAuth2 access token, sent as `Authorization:
    /// Bearer`. Scoped to `https://storage.azure.com/`. Cannot mint a service
    /// SAS (that needs the account key or a user-delegation key), so `share_url`
    /// is unavailable under this auth.
    Bearer(String),
}

pub struct AzureClient {
    http: Client,
    account: String,
    /// Service base, e.g. `https://acct.blob.core.windows.net` (subdomain) or
    /// `http://127.0.0.1:10000/devstoreaccount1` (Azurite path-style).
    base: Url,
    auth: AzureAuth,
}

/// Derive the blob service base URL from account + optional explicit endpoint /
/// suffix. An explicit endpoint (e.g. Azurite's BlobEndpoint) wins.
pub fn azure_base_url(
    account: &str,
    endpoint: Option<&str>,
    endpoint_suffix: Option<&str>,
) -> Result<Url, String> {
    let raw = match endpoint.filter(|e| !e.is_empty()) {
        Some(e) => e.to_string(),
        None => {
            let suffix = endpoint_suffix
                .filter(|s| !s.is_empty())
                .unwrap_or("core.windows.net");
            format!("https://{account}.blob.{suffix}")
        }
    };
    Url::parse(raw.trim_end_matches('/')).map_err(|e| format!("invalid azure endpoint: {e}"))
}

/// Parse an Azure storage connection string into (account, base_url, auth).
pub fn parse_connection_string(cs: &str) -> Result<(String, Url, AzureAuth), String> {
    let mut account = None;
    let mut key = None;
    let mut sas = None;
    let mut blob_endpoint = None;
    let mut suffix = None;
    let mut protocol = "https";
    for part in cs.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (k, v) = part.split_once('=').ok_or("malformed connection string")?;
        match k.trim().to_ascii_lowercase().as_str() {
            "accountname" => account = Some(v.trim().to_string()),
            "accountkey" => key = Some(v.trim().to_string()),
            "sharedaccesssignature" => sas = Some(v.trim().trim_start_matches('?').to_string()),
            "blobendpoint" => blob_endpoint = Some(v.trim().to_string()),
            "endpointsuffix" => suffix = Some(v.trim().to_string()),
            "defaultendpointsprotocol" => {
                protocol = if v.trim().eq_ignore_ascii_case("http") {
                    "http"
                } else {
                    "https"
                }
            }
            _ => {}
        }
    }
    let account = account.ok_or("connection string missing AccountName")?;
    let base = match blob_endpoint {
        Some(e) => {
            Url::parse(e.trim_end_matches('/')).map_err(|e| format!("invalid BlobEndpoint: {e}"))?
        }
        None => {
            let suffix = suffix.unwrap_or_else(|| "core.windows.net".into());
            Url::parse(&format!("{protocol}://{account}.blob.{suffix}"))
                .map_err(|e| format!("invalid derived endpoint: {e}"))?
        }
    };
    let auth = if let Some(sas) = sas {
        AzureAuth::Sas(sas)
    } else if let Some(k) = key {
        AzureAuth::SharedKey(decode_account_key(&k)?)
    } else {
        return Err("connection string needs AccountKey or SharedAccessSignature".into());
    };
    Ok((account, base, auth))
}

/// Base64-decode an account key into its raw bytes for HMAC signing.
pub fn decode_account_key(key: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .map_err(|e| format!("account key is not valid base64: {e}"))
}

/// Obtain an Entra ID (Azure AD) access token for the Blob service. A pasted
/// token wins; otherwise we shell out to the Azure CLI
/// (`az account get-access-token --resource https://storage.azure.com/`), which
/// uses whatever identity the user is signed into (`az login`). Requires `az`
/// on PATH. Dependency-free — no `azure_identity` SDK.
pub async fn acquire_bearer_token(pasted: Option<&str>) -> Result<String, String> {
    if let Some(t) = pasted.map(str::trim).filter(|t| !t.is_empty()) {
        return Ok(t.to_string());
    }
    let output = tokio::process::Command::new("az")
        .args([
            "account",
            "get-access-token",
            "--resource",
            "https://storage.azure.com/",
            "--output",
            "json",
        ])
        .output()
        .await
        .map_err(|e| {
            format!(
                "no access token provided and the Azure CLI (`az`) is not available to obtain \
                 one: {e}"
            )
        })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "`az account get-access-token` failed (run `az login` first?): {}",
            err.trim()
        ));
    }
    #[derive(Deserialize)]
    struct Token {
        #[serde(rename = "accessToken")]
        access_token: String,
    }
    let token: Token = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("could not parse `az` token output: {e}"))?;
    if token.access_token.is_empty() {
        return Err("Azure CLI returned an empty access token".into());
    }
    Ok(token.access_token)
}

impl AzureClient {
    pub fn new(http: Client, account: String, base: Url, auth: AzureAuth) -> Self {
        Self {
            http,
            account,
            base,
            auth,
        }
    }

    fn base_str(&self) -> &str {
        self.base.as_str().trim_end_matches('/')
    }

    /// Build a request URL from a relative path (container or container/blob)
    /// and query params, percent-encoding values correctly.
    fn build(&self, rel_path: &str, query: &[(&str, &str)]) -> Url {
        let mut s = String::from(self.base_str());
        if !rel_path.is_empty() {
            s.push('/');
            s.push_str(rel_path);
        }
        let mut u = Url::parse(&s).expect("valid azure url");
        if !query.is_empty() {
            let mut qp = u.query_pairs_mut();
            for (k, v) in query {
                qp.append_pair(k, v);
            }
        }
        u
    }

    /// Compute the `Authorization: SharedKey ...` header value for a request.
    fn sign(
        &self,
        key: &[u8],
        verb: &str,
        url: &Url,
        ms_headers: &[(String, String)],
        content_length: usize,
        content_type: &str,
    ) -> String {
        let mut ms: Vec<(String, String)> = ms_headers
            .iter()
            .filter(|(k, _)| k.starts_with("x-ms-"))
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        ms.sort_by(|a, b| a.0.cmp(&b.0));
        let canon_headers: String = ms.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();

        let mut canon_resource = format!("/{}{}", self.account, url.path());
        let mut qp: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.into_owned()))
            .collect();
        qp.sort_by(|a, b| a.0.cmp(&b.0));
        for (k, v) in &qp {
            canon_resource.push_str(&format!("\n{k}:{v}"));
        }

        let cl = if content_length == 0 {
            String::new()
        } else {
            content_length.to_string()
        };
        // VERB, Content-Encoding, Content-Language, Content-Length, Content-MD5,
        // Content-Type, Date, If-Modified-Since, If-Match, If-None-Match,
        // If-Unmodified-Since, Range — Date is empty because x-ms-date is used.
        let head = [verb, "", "", &cl, "", content_type, "", "", "", "", "", ""].join("\n");
        let string_to_sign = format!("{head}\n{canon_headers}{canon_resource}");

        let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
        mac.update(string_to_sign.as_bytes());
        let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
        format!("SharedKey {}:{}", self.account, sig)
    }

    /// Execute a request with the configured auth (Shared Key signing, or SAS
    /// appended to the URL).
    async fn send(
        &self,
        verb: reqwest::Method,
        url: Url,
        body: Option<Vec<u8>>,
        extra_ms_headers: &[(&str, &str)],
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let date = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let mut headers: Vec<(String, String)> = vec![
            ("x-ms-date".to_string(), date),
            ("x-ms-version".to_string(), MS_VERSION.to_string()),
        ];
        for (k, v) in extra_ms_headers {
            headers.push((k.to_string(), v.to_string()));
        }
        let content_length = body.as_ref().map(|b| b.len()).unwrap_or(0);

        let (final_url, sign) = match &self.auth {
            AzureAuth::Sas(sas) => {
                let sep = if url.query().is_some() { '&' } else { '?' };
                let u = Url::parse(&format!("{url}{sep}{sas}"))
                    .map_err(|e| format!("invalid SAS url: {e}"))?;
                (u, None)
            }
            AzureAuth::SharedKey(key) => {
                let auth = self.sign(
                    key,
                    verb.as_str(),
                    &url,
                    &headers,
                    content_length,
                    content_type.unwrap_or(""),
                );
                (url, Some(auth))
            }
            AzureAuth::Bearer(token) => (url, Some(format!("Bearer {token}"))),
        };

        let mut rb = self.http.request(verb, final_url);
        for (k, v) in &headers {
            rb = rb.header(k, v);
        }
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if let Some(auth) = sign {
            rb = rb.header("authorization", auth);
        }
        // Azure's PutBlob requires an explicit Content-Length; reqwest omits it
        // for an empty body, so set it ourselves for any body-bearing request.
        if body.is_some() {
            rb = rb.header(reqwest::header::CONTENT_LENGTH, content_length.to_string());
        }
        if let Some(b) = body {
            rb = rb.body(b);
        }
        let resp = rb.send().await.map_err(net_err)?;
        check(resp).await
    }
}

fn net_err(e: reqwest::Error) -> String {
    format!("request failed: {e}")
}

/// Build a fixed-width, base64-encoded block id (Azure requires all block ids
/// in one blob to be the same length).
fn block_id(index: u32) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{index:08}"))
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let code = resp
        .headers()
        .get("x-ms-error-code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.unwrap_or_default();
    Err(format!(
        "Azure error {} {}: {}",
        status.as_u16(),
        code,
        body.chars().take(400).collect::<String>()
    ))
}

fn parse_http_date(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S GMT")
        .ok()
        .map(|dt| dt.and_utc().timestamp())
}

impl AzureClient {
    /// List containers (the bucket-level analog).
    pub async fn list_buckets(&self) -> Result<Vec<BucketEntry>, String> {
        let url = self.build("", &[("comp", "list")]);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        let body = resp.text().await.map_err(net_err)?;
        let parsed: EnumerationResults =
            quick_xml::de::from_str(&body).map_err(|e| format!("parse containers: {e}"))?;
        Ok(parsed
            .containers
            .map(|c| c.container)
            .unwrap_or_default()
            .into_iter()
            .map(|c| BucketEntry {
                name: c.name,
                created_at: c
                    .properties
                    .and_then(|p| p.last_modified)
                    .as_deref()
                    .and_then(parse_http_date),
                region: None,
            })
            .collect())
    }

    pub async fn list_objects(
        &self,
        container: &str,
        prefix: &str,
        continuation: Option<&str>,
        max_keys: usize,
    ) -> Result<ObjectListPage, String> {
        let max = max_keys.to_string();
        let mut query: Vec<(&str, &str)> = vec![
            ("restype", "container"),
            ("comp", "list"),
            ("delimiter", "/"),
            ("maxresults", &max),
        ];
        if !prefix.is_empty() {
            query.push(("prefix", prefix));
        }
        if let Some(m) = continuation {
            query.push(("marker", m));
        }
        let url = self.build(container, &query);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        let body = resp.text().await.map_err(net_err)?;
        let parsed: EnumerationResults =
            quick_xml::de::from_str(&body).map_err(|e| format!("parse blobs: {e}"))?;

        let blobs = parsed.blobs.unwrap_or_default();
        let mut entries = Vec::with_capacity(blobs.blob.len() + blobs.blob_prefix.len());
        for bp in blobs.blob_prefix {
            let trimmed = bp.name.trim_end_matches('/');
            let name = trimmed.rsplit('/').next().unwrap_or(trimmed).to_string();
            entries.push(ObjectEntry {
                name,
                key: bp.name,
                is_dir: true,
                size: 0,
                last_modified: None,
                etag: None,
                storage_class: None,
            });
        }
        for b in blobs.blob {
            if b.name == prefix {
                continue; // skip the folder-marker blob equal to the prefix
            }
            let name = b.name.strip_prefix(prefix).unwrap_or(&b.name).to_string();
            let props = b.properties.unwrap_or_default();
            entries.push(ObjectEntry {
                name,
                key: b.name,
                is_dir: false,
                size: props.content_length.unwrap_or(0),
                last_modified: props.last_modified.as_deref().and_then(parse_http_date),
                etag: props.etag.map(|e| e.trim_matches('"').to_string()),
                storage_class: props.access_tier,
            });
        }
        let next = parsed.next_marker.filter(|m| !m.is_empty());
        Ok(ObjectListPage {
            entries,
            next_token: next,
        })
    }

    pub async fn get_object_bytes(&self, container: &str, key: &str) -> Result<Vec<u8>, String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        Ok(resp.bytes().await.map_err(net_err)?.to_vec())
    }

    /// HEAD a blob and build its metadata from the response headers.
    pub async fn head_object(&self, container: &str, key: &str) -> Result<ObjectMetadata, String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        let resp = self
            .send(reqwest::Method::HEAD, url, None, &[], None)
            .await?;
        let h = resp.headers();
        let get = |name: &str| {
            h.get(name)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        };
        let mut user_metadata = std::collections::BTreeMap::new();
        for (name, value) in h.iter() {
            if let Some(k) = name.as_str().strip_prefix("x-ms-meta-") {
                if let Ok(v) = value.to_str() {
                    user_metadata.insert(k.to_ascii_lowercase(), v.to_string());
                }
            }
        }
        Ok(ObjectMetadata {
            key: key.to_string(),
            size: get("content-length")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
            content_type: get("content-type"),
            etag: get("etag").map(|e| e.trim_matches('"').to_string()),
            last_modified: get("last-modified").as_deref().and_then(parse_http_date),
            storage_class: get("x-ms-access-tier"),
            cache_control: get("cache-control"),
            content_encoding: get("content-encoding"),
            content_disposition: get("content-disposition"),
            user_metadata,
        })
    }

    pub async fn put_object_bytes(
        &self,
        container: &str,
        key: &str,
        body: Vec<u8>,
    ) -> Result<(), String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        self.send(
            reqwest::Method::PUT,
            url,
            Some(body),
            &[("x-ms-blob-type", "BlockBlob")],
            Some("application/octet-stream"),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_object(&self, container: &str, key: &str) -> Result<(), String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        self.send(reqwest::Method::DELETE, url, None, &[], None)
            .await?;
        Ok(())
    }

    /// Server-side Copy Blob, including across containers. With Shared Key the
    /// source is authorized by the same account; with SAS the same token is
    /// appended to the source URL.
    pub async fn copy_object(
        &self,
        src_container: &str,
        src_key: &str,
        dst_container: &str,
        dst_key: &str,
    ) -> Result<(), String> {
        let src_url = self.build(&format!("{src_container}/{src_key}"), &[]);
        let copy_source = match &self.auth {
            AzureAuth::Sas(sas) => format!("{src_url}?{sas}"),
            AzureAuth::SharedKey(_) | AzureAuth::Bearer(_) => src_url.to_string(),
        };
        let dst_url = self.build(&format!("{dst_container}/{dst_key}"), &[]);
        self.send(
            reqwest::Method::PUT,
            dst_url,
            None,
            &[("x-ms-copy-source", copy_source.as_str())],
            None,
        )
        .await?;
        Ok(())
    }

    /// Recursively delete every blob under `prefix` with bounded concurrency.
    pub async fn delete_prefix(&self, container: &str, prefix: &str) -> Result<(), String> {
        use futures::stream::{self, StreamExt};
        let keys = self.list_all_keys(container, prefix).await?;
        let results: Vec<Result<(), String>> = stream::iter(keys.into_iter().map(|k| {
            let container = container.to_string();
            async move { self.delete_object(&container, &k).await }
        }))
        .buffer_unordered(16)
        .collect()
        .await;
        for r in results {
            r?;
        }
        Ok(())
    }

    /// Rename a virtual folder while preserving empty-folder marker blobs.
    pub async fn move_prefix(
        &self,
        container: &str,
        old_prefix: &str,
        new_prefix: &str,
    ) -> Result<(), String> {
        let old_prefix = folder_marker_key(old_prefix);
        let new_prefix = folder_marker_key(new_prefix);
        if old_prefix.is_empty() || new_prefix.is_empty() {
            return Err("folder prefixes must not be empty".into());
        }
        if old_prefix == new_prefix {
            return Ok(());
        }
        let keys = self.list_all_keys(container, &old_prefix).await?;
        if keys.is_empty() {
            return Err(format!("folder prefix '{old_prefix}' does not exist"));
        }

        let plan = move_prefix_plan(&old_prefix, &new_prefix, keys)?;
        for (src, dst) in &plan {
            self.copy_object(container, src, container, dst).await?;
        }
        for (src, _) in &plan {
            self.delete_object(container, src).await?;
        }
        Ok(())
    }

    /// Page through every blob name under `prefix` (no delimiter).
    async fn list_all_keys(&self, container: &str, prefix: &str) -> Result<Vec<String>, String> {
        let mut keys = Vec::new();
        let mut marker: Option<String> = None;
        loop {
            let mut query: Vec<(&str, &str)> = vec![
                ("restype", "container"),
                ("comp", "list"),
                ("maxresults", "5000"),
            ];
            if !prefix.is_empty() {
                query.push(("prefix", prefix));
            }
            if let Some(m) = &marker {
                query.push(("marker", m));
            }
            let url = self.build(container, &query);
            let resp = self
                .send(reqwest::Method::GET, url, None, &[], None)
                .await?;
            let body = resp.text().await.map_err(net_err)?;
            let parsed: EnumerationResults =
                quick_xml::de::from_str(&body).map_err(|e| format!("parse blobs: {e}"))?;
            if let Some(blobs) = parsed.blobs {
                keys.extend(blobs.blob.into_iter().map(|b| b.name));
            }
            match parsed.next_marker.filter(|m| !m.is_empty()) {
                Some(m) => marker = Some(m),
                None => break,
            }
        }
        Ok(keys)
    }

    pub async fn create_folder(&self, container: &str, prefix: &str) -> Result<(), String> {
        let key = folder_marker_key(prefix);
        self.put_object_bytes(container, &key, Vec::new()).await
    }

    pub async fn create_bucket(&self, container: &str) -> Result<(), String> {
        let url = self.build(container, &[("restype", "container")]);
        self.send(reqwest::Method::PUT, url, None, &[], None)
            .await?;
        Ok(())
    }

    pub async fn delete_bucket(&self, container: &str) -> Result<(), String> {
        let url = self.build(container, &[("restype", "container")]);
        self.send(reqwest::Method::DELETE, url, None, &[], None)
            .await?;
        Ok(())
    }

    /// Build a shareable read-only URL for a blob, valid for `ttl_secs`. With
    /// Shared Key we mint a service SAS (signed with the account key); with an
    /// existing SAS token we just append it to the blob URL.
    pub fn presign_get(&self, container: &str, key: &str, ttl_secs: u64) -> Result<String, String> {
        let blob_url = self.build(&format!("{container}/{key}"), &[]);
        match &self.auth {
            AzureAuth::Sas(sas) => Ok(format!("{blob_url}?{sas}")),
            AzureAuth::SharedKey(account_key) => {
                let expiry = (chrono::Utc::now() + chrono::Duration::seconds(ttl_secs as i64))
                    .format("%Y-%m-%dT%H:%M:%SZ")
                    .to_string();
                let protocol = if self.base.scheme() == "https" {
                    "https"
                } else {
                    "https,http"
                };
                let permissions = "r";
                let resource = "b";
                let canonical = format!("/blob/{}/{}/{}", self.account, container, key);
                // Service SAS string-to-sign for api-version 2020-12-06+ (16
                // newline-joined fields). Empty fields: start, identifier, IP,
                // snapshot, encryption scope, and the five response-override
                // headers (rscc/rscd/rsce/rscl/rsct).
                let fields = [
                    permissions,
                    "",
                    expiry.as_str(),
                    canonical.as_str(),
                    "",
                    "",
                    protocol,
                    MS_VERSION,
                    resource,
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ];
                let string_to_sign = fields.join("\n");
                let mut mac =
                    HmacSha256::new_from_slice(account_key).expect("hmac accepts any key length");
                mac.update(string_to_sign.as_bytes());
                let sig =
                    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
                let query = format!(
                    "sv={}&sr={}&sp={}&se={}&spr={}&sig={}",
                    MS_VERSION,
                    resource,
                    permissions,
                    urlencoding::encode(&expiry),
                    urlencoding::encode(protocol),
                    urlencoding::encode(&sig),
                );
                Ok(format!("{blob_url}?{query}"))
            }
            AzureAuth::Bearer(_) => Err(
                "share links require account-key or SAS auth; an Entra ID (bearer) connection \
                 cannot mint a SAS"
                    .into(),
            ),
        }
    }

    /// Stream a blob to a local file, emitting progress.
    pub async fn download_to_file<R: Runtime>(
        &self,
        container: &str,
        key: &str,
        dest: &Path,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        let url = self.build(&format!("{container}/{key}"), &[]);
        let resp = self
            .send(reqwest::Method::GET, url, None, &[], None)
            .await?;
        let total = resp.content_length().unwrap_or(0);
        super::transfer::stream_to_file(resp, total, dest, transfer_id, handle, app).await
    }

    /// Upload a local file. Small files go in one Put Blob; large files are
    /// staged as blocks then committed with Put Block List, emitting progress
    /// per block. `access_tier`, when set (`Hot`/`Cool`/`Cold`/`Archive`), is
    /// applied via `x-ms-access-tier`.
    pub async fn upload_from_file<R: Runtime>(
        &self,
        local: &Path,
        container: &str,
        key: &str,
        access_tier: Option<&str>,
        transfer_id: &str,
        handle: &Arc<TransferHandle>,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        use super::transfer::{
            MULTIPART_THRESHOLD, PART_SIZE, emit_paused, emit_progress, read_full,
        };
        let total = tokio::fs::metadata(local)
            .await
            .map_err(|e| format!("stat {}: {e}", local.display()))?
            .len();
        let started = Instant::now();
        emit_progress(app, transfer_id, 0, total, started);

        if total <= MULTIPART_THRESHOLD {
            let data = tokio::fs::read(local)
                .await
                .map_err(|e| format!("read {}: {e}", local.display()))?;
            let url = self.build(&format!("{container}/{key}"), &[]);
            let mut ms_headers: Vec<(&str, &str)> = vec![("x-ms-blob-type", "BlockBlob")];
            if let Some(tier) = access_tier {
                ms_headers.push(("x-ms-access-tier", tier));
            }
            self.send(
                reqwest::Method::PUT,
                url,
                Some(data),
                &ms_headers,
                Some("application/octet-stream"),
            )
            .await?;
            emit_progress(app, transfer_id, total, total, started);
            return Ok(());
        }

        let mut file = tokio::fs::File::open(local)
            .await
            .map_err(|e| format!("open {}: {e}", local.display()))?;
        let mut buf = vec![0u8; PART_SIZE];
        let mut block_ids: Vec<String> = Vec::new();
        let mut uploaded: u64 = 0;
        let mut index: u32 = 0;
        loop {
            if handle.is_cancelled() {
                return Err("transfer cancelled".to_string());
            }
            if handle.is_paused() {
                emit_paused(app, transfer_id, uploaded, total);
                handle.wait_while_paused().await;
                if handle.is_cancelled() {
                    return Err("transfer cancelled".to_string());
                }
            }
            let n = read_full(&mut file, &mut buf).await?;
            if n == 0 {
                break;
            }
            let id = block_id(index);
            let url = self.build(
                &format!("{container}/{key}"),
                &[("comp", "block"), ("blockid", id.as_str())],
            );
            self.send(
                reqwest::Method::PUT,
                url,
                Some(buf[..n].to_vec()),
                &[],
                None,
            )
            .await?;
            block_ids.push(id);
            uploaded += n as u64;
            emit_progress(app, transfer_id, uploaded, total, started);
            index += 1;
        }

        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<BlockList>\n");
        for id in &block_ids {
            xml.push_str("  <Latest>");
            xml.push_str(id);
            xml.push_str("</Latest>\n");
        }
        xml.push_str("</BlockList>");
        let url = self.build(&format!("{container}/{key}"), &[("comp", "blocklist")]);
        let mut ms_headers: Vec<(&str, &str)> = Vec::new();
        if let Some(tier) = access_tier {
            ms_headers.push(("x-ms-access-tier", tier));
        }
        self.send(
            reqwest::Method::PUT,
            url,
            Some(xml.into_bytes()),
            &ms_headers,
            Some("application/xml"),
        )
        .await?;
        emit_progress(app, transfer_id, total, total, started);
        Ok(())
    }

    pub async fn ping(&self, _default_location: Option<&str>) -> Result<(), String> {
        self.list_buckets().await.map(|_| ())
    }
}

fn folder_marker_key(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

fn move_prefix_plan(
    old_prefix: &str,
    new_prefix: &str,
    keys: Vec<String>,
) -> Result<Vec<(String, String)>, String> {
    keys.into_iter()
        .map(|key| {
            let suffix = key
                .strip_prefix(old_prefix)
                .ok_or_else(|| format!("blob '{key}' is outside prefix '{old_prefix}'"))?
                .to_string();
            Ok((key, format!("{new_prefix}{suffix}")))
        })
        .collect()
}

#[derive(Debug, Default, Deserialize)]
struct EnumerationResults {
    #[serde(rename = "Containers")]
    containers: Option<Containers>,
    #[serde(rename = "Blobs")]
    blobs: Option<Blobs>,
    #[serde(rename = "NextMarker")]
    next_marker: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Containers {
    #[serde(default, rename = "Container")]
    container: Vec<ContainerXml>,
}

#[derive(Debug, Deserialize)]
struct ContainerXml {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Properties")]
    properties: Option<ContainerProps>,
}

#[derive(Debug, Deserialize)]
struct ContainerProps {
    #[serde(rename = "Last-Modified")]
    last_modified: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Blobs {
    #[serde(default, rename = "Blob")]
    blob: Vec<BlobXml>,
    #[serde(default, rename = "BlobPrefix")]
    blob_prefix: Vec<BlobPrefixXml>,
}

#[derive(Debug, Deserialize)]
struct BlobXml {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Properties")]
    properties: Option<BlobProps>,
}

#[derive(Debug, Default, Deserialize)]
struct BlobProps {
    #[serde(rename = "Content-Length")]
    content_length: Option<u64>,
    #[serde(rename = "Last-Modified")]
    last_modified: Option<String>,
    #[serde(rename = "Etag", alias = "ETag")]
    etag: Option<String>,
    #[serde(rename = "AccessTier")]
    access_tier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BlobPrefixXml {
    #[serde(rename = "Name")]
    name: String,
}

#[cfg(test)]
mod it {
    use super::*;

    /// End-to-end round trip against Azurite. Skipped unless `TAOMNI_AZ_IT` is
    /// set. Uses Azurite's well-known public dev account/key (not a secret).
    /// Exercises Shared Key signing, container/blob ops, and delimiter→folder
    /// mapping.
    #[tokio::test]
    async fn azure_round_trip() {
        if std::env::var("TAOMNI_AZ_IT").is_err() {
            return;
        }
        let cs = std::env::var("TAOMNI_AZ_IT_CONNSTR").unwrap_or_else(|_| {
            "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;".into()
        });
        let (account, base, auth) = parse_connection_string(&cs).expect("parse connection string");
        let client = AzureClient::new(reqwest::Client::new(), account, base, auth);

        let container = format!("taomniit{}", uuid::Uuid::new_v4().simple());
        client
            .create_bucket(&container)
            .await
            .expect("create container");

        let buckets = client.list_buckets().await.expect("list containers");
        assert!(
            buckets.iter().any(|b| b.name == container),
            "new container listed"
        );

        client
            .put_object_bytes(&container, "dir/hello.txt", b"hi there".to_vec())
            .await
            .expect("put blob");
        client
            .create_folder(&container, "emptydir")
            .await
            .expect("create folder");

        let root = client
            .list_objects(&container, "", None, 1000)
            .await
            .expect("list root");
        assert!(
            root.entries.iter().any(|e| e.is_dir && e.name == "dir"),
            "dir/ surfaces as a folder"
        );

        let inside = client
            .list_objects(&container, "dir/", None, 1000)
            .await
            .expect("list dir/");
        let file = inside
            .entries
            .iter()
            .find(|e| !e.is_dir)
            .expect("file under dir/");
        assert_eq!(file.name, "hello.txt");
        assert_eq!(file.size, 8);

        let bytes = client
            .get_object_bytes(&container, "dir/hello.txt")
            .await
            .expect("get");
        assert_eq!(bytes, b"hi there");

        // --- P3 management ops ---
        let meta = client
            .head_object(&container, "dir/hello.txt")
            .await
            .expect("head");
        assert_eq!(meta.size, 8);

        client
            .copy_object(&container, "dir/hello.txt", &container, "dir2/copy.txt")
            .await
            .expect("copy blob");
        let copied = client
            .get_object_bytes(&container, "dir2/copy.txt")
            .await
            .expect("get copy");
        assert_eq!(copied, b"hi there");

        // Service SAS should be fetchable with no auth header.
        let url = client
            .presign_get(&container, "dir/hello.txt", 300)
            .expect("presign");
        let presigned = reqwest::get(&url)
            .await
            .expect("fetch sas")
            .bytes()
            .await
            .expect("bytes");
        assert_eq!(&presigned[..], b"hi there");

        client
            .delete_prefix(&container, "dir/")
            .await
            .expect("delete_prefix");
        let after = client
            .list_objects(&container, "", None, 1000)
            .await
            .expect("relist");
        assert!(
            !after.entries.iter().any(|e| e.name == "dir"),
            "dir/ gone after delete_prefix"
        );

        client
            .delete_object(&container, "dir2/copy.txt")
            .await
            .expect("del copy");
        client
            .delete_object(&container, "emptydir/")
            .await
            .expect("del marker");
        client
            .delete_bucket(&container)
            .await
            .expect("del container");
    }
}
