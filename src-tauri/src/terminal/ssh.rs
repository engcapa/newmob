use async_trait::async_trait;
use russh::keys::key::{self as ssh_key, PublicKey, SignatureHash};
use russh::{client, kex, ChannelId, Pty};
use std::borrow::Cow;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::terminal::network::{establish_transport, NetworkSettings};

pub struct SshSession {
    pub handle: client::Handle<SshHandler>,
}

pub struct SshHandler {
    pub output_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>>,
}

#[async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO: proper host key verification
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = self.output_tx.lock().await.as_ref() {
            let _ = tx.send(data.to_vec());
        }
        Ok(())
    }

    async fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = self.output_tx.lock().await.as_ref() {
            let _ = tx.send(data.to_vec());
        }
        Ok(())
    }
}

pub enum SshAuth {
    Password(String),
    PrivateKey(String),
    Agent,
}

const COMPAT_KEX_ORDER: &[kex::Name] = &[
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::ECDH_SHA2_NISTP256,
    kex::ECDH_SHA2_NISTP384,
    kex::ECDH_SHA2_NISTP521,
    kex::DH_G16_SHA512,
    kex::DH_G14_SHA256,
    kex::DH_G14_SHA1,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_SUPPORT_AS_SERVER,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
];

const COMPAT_HOST_KEY_ORDER: &[ssh_key::Name] = &[
    ssh_key::ED25519,
    ssh_key::ECDSA_SHA2_NISTP256,
    ssh_key::ECDSA_SHA2_NISTP384,
    ssh_key::ECDSA_SHA2_NISTP521,
    ssh_key::RSA_SHA2_512,
    ssh_key::RSA_SHA2_256,
    ssh_key::SSH_RSA,
];

const DEFAULT_PTY_MODES: &[(Pty, u32)] = &[
    (Pty::VINTR, 3),
    (Pty::VQUIT, 28),
    (Pty::VERASE, 127),
    (Pty::VKILL, 21),
    (Pty::VEOF, 4),
    (Pty::VSTART, 17),
    (Pty::VSTOP, 19),
    (Pty::VSUSP, 26),
    (Pty::VREPRINT, 18),
    (Pty::VWERASE, 23),
    (Pty::VLNEXT, 22),
    (Pty::IGNPAR, 0),
    (Pty::PARMRK, 0),
    (Pty::INPCK, 0),
    (Pty::ISTRIP, 0),
    (Pty::INLCR, 0),
    (Pty::IGNCR, 0),
    (Pty::ICRNL, 1),
    (Pty::IXON, 1),
    (Pty::IXANY, 0),
    (Pty::IXOFF, 0),
    (Pty::IMAXBEL, 1),
    (Pty::IUTF8, 1),
    (Pty::ISIG, 1),
    (Pty::ICANON, 1),
    (Pty::ECHO, 1),
    (Pty::ECHOE, 1),
    (Pty::ECHOK, 1),
    (Pty::ECHONL, 0),
    (Pty::NOFLSH, 0),
    (Pty::TOSTOP, 0),
    (Pty::IEXTEN, 1),
    (Pty::ECHOCTL, 1),
    (Pty::ECHOKE, 1),
    (Pty::OPOST, 1),
    (Pty::OLCUC, 0),
    (Pty::ONLCR, 1),
    (Pty::OCRNL, 0),
    (Pty::ONOCR, 0),
    (Pty::ONLRET, 0),
    (Pty::CS7, 0),
    (Pty::CS8, 1),
    (Pty::PARENB, 0),
    (Pty::PARODD, 0),
    (Pty::TTY_OP_ISPEED, 38400),
    (Pty::TTY_OP_OSPEED, 38400),
];

fn build_client_config(network: Option<&NetworkSettings>) -> Arc<client::Config> {
    let mut cfg = client::Config::default();
    let preferred = cfg.preferred.clone();
    cfg.preferred = russh::Preferred {
        kex: Cow::Borrowed(COMPAT_KEX_ORDER),
        key: Cow::Borrowed(COMPAT_HOST_KEY_ORDER),
        cipher: preferred.cipher,
        mac: preferred.mac,
        compression: preferred.compression,
    };
    if let Some(n) = network {
        if let Some(d) = n.keepalive_duration() {
            cfg.keepalive_interval = Some(d);
            cfg.keepalive_max = 3;
        }
    }
    Arc::new(cfg)
}

async fn authenticate(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    auth: SshAuth,
) -> Result<(), String> {
    match auth {
        SshAuth::Password(password) => {
            let ok = handle
                .authenticate_password(username, &password)
                .await
                .map_err(|e| format!("SSH auth failed: {}", e))?;
            if !ok {
                return Err("SSH password authentication rejected".to_string());
            }
        }
        SshAuth::PrivateKey(key_path) => {
            let key_path = shellexpand::tilde(&key_path).to_string();
            let key = russh_keys::load_secret_key(&key_path, None)
                .map_err(|e| format!("Failed to load key {}: {}", key_path, e))?;
            authenticate_private_key(handle, username, key).await?;
        }
        SshAuth::Agent => {
            return Err("SSH agent auth not yet implemented".to_string());
        }
    }
    Ok(())
}

async fn authenticate_private_key(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    key: ssh_key::KeyPair,
) -> Result<(), String> {
    let attempts = private_key_auth_attempts(&key);
    let mut tried = Vec::with_capacity(attempts.len());

    for key in attempts {
        let algorithm = key.name().to_string();
        tried.push(algorithm.clone());
        let ok = handle
            .authenticate_publickey(username, Arc::new(key))
            .await
            .map_err(|e| format!("SSH key auth failed using {}: {}", algorithm, e))?;
        if ok {
            return Ok(());
        }
    }

    Err(format!(
        "SSH key authentication rejected (tried {})",
        tried.join(", ")
    ))
}

fn private_key_auth_attempts(key: &ssh_key::KeyPair) -> Vec<ssh_key::KeyPair> {
    let rsa_attempts = [
        SignatureHash::SHA2_512,
        SignatureHash::SHA2_256,
        SignatureHash::SHA1,
    ]
    .into_iter()
    .filter_map(|hash| key.with_signature_hash(hash))
    .collect::<Vec<_>>();

    if rsa_attempts.is_empty() {
        vec![key.clone()]
    } else {
        rsa_attempts
    }
}

pub async fn connect_ssh(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    cols: u16,
    rows: u16,
    network: Option<&NetworkSettings>,
) -> Result<
    (
        client::Handle<SshHandler>,
        russh::Channel<client::Msg>,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    ),
    String,
> {
    let (output_tx, output_rx) = tokio::sync::mpsc::unbounded_channel();

    let config = build_client_config(network);

    let handler = SshHandler {
        output_tx: Arc::new(Mutex::new(Some(output_tx))),
    };

    let stream = establish_transport(host, port, network).await?;
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    authenticate(&mut handle, username, auth).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open SSH channel: {}", e))?;

    channel
        .request_pty(
            false,
            "xterm-256color",
            cols as u32,
            rows as u32,
            0,
            0,
            DEFAULT_PTY_MODES,
        )
        .await
        .map_err(|e| format!("Failed to request PTY: {}", e))?;

    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("Failed to request shell: {}", e))?;

    Ok((handle, channel, output_rx))
}

/// Authenticate against the server and return the handle without opening a
/// PTY/shell. The SFTP module reuses this to open its own subsystem channel.
pub async fn connect_ssh_authenticated(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
) -> Result<client::Handle<SshHandler>, String> {
    connect_ssh_authenticated_with(host, port, username, auth, None).await
}

/// Same as `connect_ssh_authenticated` but allows callers to pass through
/// per-session network settings (proxy, keep-alive, IP version, …).
pub async fn connect_ssh_authenticated_with(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    network: Option<&NetworkSettings>,
) -> Result<client::Handle<SshHandler>, String> {
    let config = build_client_config(network);
    let handler = SshHandler {
        output_tx: Arc::new(Mutex::new(None)),
    };

    let stream = establish_transport(host, port, network).await?;
    let mut handle = client::connect_stream(config, stream, handler)
        .await
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    authenticate(&mut handle, username, auth).await?;
    Ok(handle)
}
