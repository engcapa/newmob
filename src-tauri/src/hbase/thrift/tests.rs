//! Pure unit tests for the Thrift backend's mapping helpers (no network).

use super::*;

#[test]
fn parse_column_splits_family_qualifier() {
    let c = parse_column("cf:q");
    assert_eq!(c.family, b"cf");
    assert_eq!(c.qualifier.as_deref(), Some(&b"q"[..]));
}

#[test]
fn parse_column_bare_family_has_no_qualifier() {
    let c = parse_column("cf");
    assert_eq!(c.family, b"cf");
    assert!(c.qualifier.is_none());
}

#[test]
fn split_column_requires_qualifier() {
    assert!(split_column("cf").is_err());
    assert_eq!(
        split_column("cf:q").unwrap(),
        (b"cf".to_vec(), b"q".to_vec())
    );
}

#[test]
fn table_name_parses_namespace_prefix() {
    let tn = table_name_of(None, "ns1:t1");
    assert_eq!(tn.ns.as_deref(), Some(&b"ns1"[..]));
    assert_eq!(tn.qualifier, b"t1");
}

#[test]
fn table_name_uses_session_namespace_when_unqualified() {
    let tn = table_name_of(Some("myns"), "t1");
    assert_eq!(tn.ns.as_deref(), Some(&b"myns"[..]));
    assert_eq!(tn.qualifier, b"t1");

    let tn2 = table_name_of(None, "t1");
    assert!(tn2.ns.is_none());
    assert_eq!(tn2.qualifier, b"t1");
}

#[test]
fn qualify_prefixes_namespace_only_when_unqualified() {
    assert_eq!(qualify(Some("ns"), "t1"), b"ns:t1");
    assert_eq!(qualify(Some("ns"), "other:t1"), b"other:t1");
    assert_eq!(qualify(None, "t1"), b"t1");
}

#[test]
fn render_table_name_omits_default_namespace() {
    let plain = TTableName {
        ns: Some(b"default".to_vec()),
        qualifier: b"t1".to_vec(),
    };
    assert_eq!(render_table_name(&plain), "t1");

    let with_ns = TTableName {
        ns: Some(b"ns1".to_vec()),
        qualifier: b"t1".to_vec(),
    };
    assert_eq!(render_table_name(&with_ns), "ns1:t1");

    let no_ns = TTableName {
        ns: None,
        qualifier: b"t1".to_vec(),
    };
    assert_eq!(render_table_name(&no_ns), "t1");
}

#[test]
fn result_to_rows_flattens_cells_with_family_qualifier_column() {
    let res = TResult {
        row: Some(b"row1".to_vec()),
        column_values: vec![
            tcv(b"cf".to_vec(), b"a".to_vec(), b"v1".to_vec()),
            TColumnValue {
                timestamp: Some(42),
                ..tcv(b"cf".to_vec(), b"b".to_vec(), b"v2".to_vec())
            },
        ],
        stale: None,
        partial: None,
    };
    let rows = result_to_rows(&res);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].row, b"row1");
    assert_eq!(rows[0].column, b"cf:a");
    assert_eq!(rows[0].value, b"v1");
    assert_eq!(rows[1].column, b"cf:b");
    assert_eq!(rows[1].timestamp, 42);
}

#[test]
fn tcfd_maps_known_shell_attributes() {
    let mut attrs = BTreeMap::new();
    attrs.insert("VERSIONS".to_string(), "3".to_string());
    attrs.insert("TTL".to_string(), "86400".to_string());
    attrs.insert("IN_MEMORY".to_string(), "true".to_string());
    let cf = tcfd("cf", &attrs);
    assert_eq!(cf.name, b"cf");
    assert_eq!(cf.max_versions, Some(3));
    assert_eq!(cf.time_to_live, Some(86400));
    assert_eq!(cf.in_memory, Some(true));
}

/// End-to-end test against a live Lindorm / HBase 增强版 Thrift2 endpoint.
///
/// Gated by HBASE_THRIFT_LIVE_TEST=1. All endpoint/credential values come from
/// the environment — nothing is hardcoded:
///   HBASE_THRIFT_LIVE_TEST=1            (gate)
///   HBASE_THRIFT_HOST=ld-xxx-proxy-lindorm.lindorm.aliyuncs.com
///   HBASE_THRIFT_PORT=9190              (optional; default 9190)
///   HBASE_THRIFT_USERNAME=...           (optional; ACL AccessKeyId)
///   HBASE_THRIFT_PASSWORD=...           (optional; ACL AccessKeySignature)
///   HBASE_THRIFT_SSL=1                  (optional; use https)
///   HBASE_THRIFT_NAMESPACE=...          (optional)
///   HBASE_THRIFT_WRITE_TEST=1           (optional; runs a create/put/get/drop cycle)
/// Run with:
///   cargo test --lib hbase::thrift::tests::thrift_connect_and_list -- --nocapture
#[tokio::test]
async fn thrift_connect_and_list() {
    fn env(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|s| !s.trim().is_empty())
    }
    if env("HBASE_THRIFT_LIVE_TEST").as_deref() != Some("1") {
        eprintln!("skipping: set HBASE_THRIFT_LIVE_TEST=1 and HBASE_THRIFT_HOST to run");
        return;
    }
    let host = env("HBASE_THRIFT_HOST").expect("HBASE_THRIFT_HOST is required");
    let config = HBaseConfig {
        host,
        port: env("HBASE_THRIFT_PORT")
            .and_then(|p| p.parse().ok())
            .unwrap_or(9190),
        username: env("HBASE_THRIFT_USERNAME"),
        password: None, // passed separately below
        ssl: env("HBASE_THRIFT_SSL").as_deref() == Some("1"),
        timeout_secs: Some(20),
        rest_path: None,
        namespace: env("HBASE_THRIFT_NAMESPACE"),
        connection_mode: Some("thrift".into()),
        zk_quorum: None,
        zk_root: None,
        effective_user: None,
        auth_method: None,
        service_principal: None,
        principal: None,
        keytab_path: None,
        krb5_conf_path: None,
        hbase_site_path: None,
    };
    let session = ThriftSession::new(&config, env("HBASE_THRIFT_PASSWORD"))
        .expect("ThriftSession::new failed");

    let ping = session.ping().await;
    eprintln!("PING: {ping:?}");
    ping.expect("ping failed");

    let tables = session.list_tables().await.expect("list failed");
    eprintln!("LIST: {} table(s) -> {:?}", tables.len(), tables);

    if env("HBASE_THRIFT_WRITE_TEST").as_deref() == Some("1") {
        let t = format!("taomni_thrift_probe_{}", std::process::id());
        let _ = session.drop_table(&t).await; // best-effort pre-clean
        session
            .create_table(&t, &[("cf".into(), BTreeMap::new())])
            .await
            .expect("create_table failed");
        session
            .put(&t, b"r1", "cf:a", b"v1")
            .await
            .expect("put failed");
        let got = session.get(&t, b"r1", None).await.expect("get failed");
        eprintln!("GET: {got:?}");
        assert!(
            got.iter().any(|row| row.value == b"v1"),
            "put value not read back"
        );
        let scanned = session
            .scan(&t, 10, None, None, &[])
            .await
            .expect("scan failed");
        eprintln!("SCAN: {} cell(s)", scanned.len());
        session
            .delete_all(&t, b"r1")
            .await
            .expect("delete_all failed");
        session.drop_table(&t).await.expect("drop_table failed");
        eprintln!("create/put/get/scan/delete/drop cycle OK for {t}");
    }
}
