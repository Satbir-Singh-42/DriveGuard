import React, { useState, useMemo } from "react";
import JSZip from "jszip";
import {
  Shield, Download, Terminal, CheckCircle, Lock,
  FileCode, Copy, Eye,
  Cpu, Key, HardDrive, Zap, AlertTriangle, Play,
  FileText, Settings, RefreshCw, Unlock, KeySquare
} from "lucide-react";
import {
  DRIVEGUARD_PY, REQUIREMENTS_TXT, INSTALL_BAT, RUN_BAT, SETUP_PY, README_MD,
} from "./constants/driveguard_py";

// ── Download helper ───────────────────────────────────────────────────────────
function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ── Reusable components ───────────────────────────────────────────────────────
function Pill({ text, color = "#1f6feb", bg = "#1f3a5f" }: { text: string; color?: string; bg?: string }) {
  return (
    <span style={{
      background: bg, color, border: `1px solid ${color}44`,
      borderRadius: "10px", padding: "2px 10px",
      fontSize: "10px", fontWeight: 700, letterSpacing: "0.04em",
    }}>{text}</span>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div style={{
      background: "#161b22", border: "1px solid #30363d", borderRadius: "10px",
      padding: "16px", display: "flex", gap: "12px", alignItems: "flex-start",
    }}>
      <div style={{
        width: "36px", height: "36px", borderRadius: "8px", background: "#21262d",
        border: "1px solid #30363d", display: "flex", alignItems: "center",
        justifyContent: "center", flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ color: "#f0f6fc", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>{title}</div>
        <div style={{ color: "#8b949e", fontSize: "11px", lineHeight: "1.5" }}>{desc}</div>
      </div>
    </div>
  );
}

// ── Brand assets ──────────────────────────────────────────────────────────────
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="dg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f6feb"/>
      <stop offset="100%" stop-color="#388bfd"/>
    </linearGradient>
  </defs>
  <path d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z" fill="url(#dg-grad)"/>
  <path d="M32 4 L56 14 V32 C56 46 45 56 32 60 C19 56 8 46 8 32 V14 Z" fill="none" stroke="#0d2a52" stroke-width="1.5"/>
  <rect x="22" y="30" width="20" height="16" rx="2" fill="#fff"/>
  <path d="M26 30 V24 a6 6 0 0 1 12 0 V30" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <circle cx="32" cy="38" r="2.5" fill="#1f6feb"/>
  <rect x="30.5" y="38" width="3" height="6" rx="1" fill="#1f6feb"/>
</svg>`;

function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-label="DriveGuard"
      style={{ width: size, height: size, display: "inline-block", flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
    />
  );
}

// ── Module-level constants (no re-creation on every render) ──────────────────
const FILES: Record<string, { content: string; lang: string }> = {
  "driveguard.py": { content: DRIVEGUARD_PY, lang: "python" },
  "requirements.txt": { content: REQUIREMENTS_TXT, lang: "text" },
  "install.bat": { content: INSTALL_BAT, lang: "batch" },
  "run.bat": { content: RUN_BAT, lang: "batch" },
  "setup.py": { content: SETUP_PY, lang: "python" },
  "README.md": { content: README_MD, lang: "markdown" },
};

const TAB_STYLE = (active: boolean) => ({
  padding: "8px 20px", border: "none", cursor: "pointer",
  background: active ? "#1c2333" : "transparent",
  color: active ? "#f0f6fc" : "#8b949e",
  borderBottom: active ? "2px solid #1f6feb" : "2px solid transparent",
  fontSize: "13px", fontWeight: 600 as const, transition: "all 0.15s",
});

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState<"overview" | "code" | "install">("overview");
  const [activeFile, setActiveFile] = useState("driveguard.py");
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const activeContent = FILES[activeFile]?.content ?? "";
  // Memoised: avoids re-splitting on every render (was called 3× previously)
  const contentLines = useMemo(() => activeContent.split("\n"), [activeContent]);
  const displayLines = showFull ? activeContent : contentLines.slice(0, 60).join("\n");

  function copyCode() {
    navigator.clipboard.writeText(activeContent).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  }

  async function downloadAll() {
    if (downloading) return;
    setDownloading(true);
    try {
      const zip = new JSZip();
      Object.entries(FILES).forEach(([name, { content }]) => {
        zip.file(name, content);
      });
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "DriveGuard_Package.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revocation so the browser has time to start the download
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#0d1117",
      fontFamily: "'Segoe UI','Inter',-apple-system,sans-serif",
      color: "#f0f6fc",
    }}>
      {/* ── Header ── */}
      <div style={{
        background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)",
        borderBottom: "1px solid #30363d",
      }}>
        {/* Top nav */}
        <div style={{
          display: "flex", alignItems: "center", padding: "12px 32px",
          borderBottom: "1px solid #21262d",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Logo size={32} />
            <span style={{ fontSize: "16px", fontWeight: 700, color: "#f0f6fc" }}>
              DriveGuard
            </span>
            <Pill text="v1.2.0" />
            <Pill text="RECOVERY CODES" color="#d29922" bg="#2d1e00" />
            <Pill text="REAL ENCRYPTION" color="#3fb950" bg="#1a3d2a" />
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={downloadAll}
              disabled={downloading}
              style={{
                padding: "8px 18px", borderRadius: "8px",
                background: "linear-gradient(135deg, #238636, #2ea043)",
                border: "none", color: "#fff", fontSize: "13px",
                fontWeight: 700, cursor: downloading ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: "6px",
                opacity: downloading ? 0.65 : 1, transition: "opacity 0.2s",
              }}
              onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (!downloading) e.currentTarget.style.opacity = "0.88"; }}
              onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { if (!downloading) e.currentTarget.style.opacity = "1"; }}
            >
              <Download size={14} />
              {downloading ? "Generating ZIP…" : "Download All Files"}
            </button>
          </div>
        </div>

        {/* Hero */}
        <div style={{ padding: "40px 32px 36px", maxWidth: "960px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
            <Lock size={18} color="#da3633" />
            <span style={{ color: "#da3633", fontSize: "12px", fontWeight: 700, letterSpacing: "0.1em" }}>
              STANDALONE AES-256-GCM ENCRYPTION
            </span>
          </div>
          <h1 style={{
            fontSize: "32px", fontWeight: 800, color: "#f0f6fc",
            margin: "0 0 14px", lineHeight: 1.2,
          }}>
            DriveGuard — Real USB Drive<br />
            <span style={{ color: "#388bfd" }}>Encryption for Windows</span>
          </h1>
          <p style={{ color: "#8b949e", fontSize: "14px", lineHeight: 1.7, margin: "0 0 20px", maxWidth: "640px" }}>
            A complete, standalone Python desktop application that encrypts every file on
            your USB/external drive using <strong style={{ color: "#f0f6fc" }}>AES-256-GCM</strong> with{" "}
            <strong style={{ color: "#f0f6fc" }}>PBKDF2-HMAC-SHA256</strong> key derivation.
            No BitLocker. No VeraCrypt. Just Python + cryptography.
          </p>

          <div style={{ marginBottom: "24px" }}>
            <a href="https://www.producthunt.com/products/driveguard?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-driveguard" target="_blank" rel="noopener noreferrer">
              <img 
                src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1174891&theme=dark&t=1781762717231" 
                alt="DriveGuard - Real AES-256-GCM USB drive encryption for Windows. | Product Hunt" 
                style={{ width: "250px", height: "54px" }} 
                width="250" 
                height="54" 
              />
            </a>
          </div>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {[
              { icon: <Key size={12} />, text: "AES-256-GCM Auth Encryption" },
              { icon: <Cpu size={12} />, text: "PBKDF2-SHA256 (310k rounds)" },
              { icon: <Shield size={12} />, text: "Master-key + Recovery Code" },
              { icon: <HardDrive size={12} />, text: "Streaming Chunked I/O (1 MiB)" },
              { icon: <Zap size={12} />, text: "WM_DEVICECHANGE Listener" },
              { icon: <Lock size={12} />, text: "Filename Obfuscation + Secure Wipe" },
            ].map((b, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: "5px",
                background: "#161b22", border: "1px solid #30363d",
                borderRadius: "20px", padding: "5px 12px",
                color: "#8b949e", fontSize: "11px", fontWeight: 600,
              }}>
                <span style={{ color: "#1f6feb" }}>{b.icon}</span> {b.text}
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", padding: "0 32px", borderTop: "1px solid #21262d" }} role="tablist">
          {(["overview", "code", "install"] as const).map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              style={TAB_STYLE(activeTab === tab)}
              onClick={() => setActiveTab(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab: Overview ── */}
      {activeTab === "overview" && (
        <div style={{ padding: "32px", maxWidth: "1100px", margin: "0 auto" }}>
          {/* HOW IT WORKS */}
          <div style={{ marginBottom: "36px" }}>
            <SectionTitle icon={<Key size={15} color="#8b949e" />} title="How the Encryption Works" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px", marginTop: "14px" }}>
              <FeatureCard
                icon={<Key size={18} color="#388bfd" />}
                title="Master-Key Model"
                desc="A random 256-bit Master Key encrypts your files. The MK is wrapped twice with AES-GCM: once under a password-derived KEK and once under a recovery-code-derived KEK. Either credential can unlock."
              />
              <FeatureCard
                icon={<Cpu size={18} color="#c9b3ff" />}
                title="Key Derivation — PBKDF2-HMAC-SHA256"
                desc="Both the password and the recovery code are stretched through PBKDF2-SHA256 with independent 256-bit salts and 310,000 iterations (NIST 2023). The KEKs only exist in memory."
              />
              <FeatureCard
                icon={<Lock size={18} color="#da3633" />}
                title="Streaming File Crypto — AES-256-GCM"
                desc="Files are encrypted in 1 MiB chunks. Each chunk gets its own 96-bit nonce and 128-bit GCM tag — multi-GB files run in constant memory and any tampered chunk fails authentication."
              />
              <FeatureCard
                icon={<Shield size={18} color="#3fb950" />}
                title="Wire Format v3 (per file)"
                desc="MAGIC(7) | VERSION(1) | FLAGS(1) | CHUNK_SIZE(4) | NAME_NONCE(12) | NAME_LEN(2) | NAME_CT+TAG | { DATA_NONCE(12) | CT+TAG }*. Original filename lives encrypted inside the header."
              />
              <FeatureCard
                icon={<HardDrive size={18} color="#d29922" />}
                title="Lock Metadata — .drivelock"
                desc="A hidden JSON file stores: salt_pwd, salt_rec, wrapped_pwd, wrapped_rec, algorithm, KDF, iteration count, and chunk size. The Master Key is NEVER written to disk in plaintext."
              />
              <FeatureCard
                icon={<RefreshCw size={18} color="#79c0ff" />}
                title="Live Device Detection"
                desc="A native Win32 WM_DEVICECHANGE listener (parsed via ctypes from Qt's nativeEvent) reacts to drive arrival/removal in ~150 ms. An 8-second poll runs as a safety net."
              />
            </div>
          </div>

          {/* FEATURES */}
          <div style={{ marginBottom: "36px" }}>
            <SectionTitle icon={<Zap size={15} color="#8b949e" />} title="Application Features" />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px", marginTop: "14px" }}>
              {[
                { icon: <HardDrive size={16} color="#388bfd" />, title: "Instant Drive Detection", desc: "Native WM_DEVICECHANGE handler reacts in ~150 ms when you plug or eject a drive. 8-second poll as a fallback." },
                { icon: <Lock size={16} color="#da3633" />, title: "Streaming Lock/Unlock", desc: "Files are processed in 1 MiB chunks with independent nonces — multi-GB files use constant memory." },
                { icon: <Key size={16} color="#d29922" />, title: "Recovery Codes", desc: "24-character base32 recovery code generated at lock time, shown once with copy/save-to-file. Unwraps the Master Key if you forget the password." },
                { icon: <Shield size={16} color="#c9b3ff" />, title: "Filename Obfuscation", desc: "Optional. Replaces on-disk filenames with random 32-hex stems. The real name is encrypted inside the file header." },
                { icon: <AlertTriangle size={16} color="#da3633" />, title: "Secure-Wipe Originals", desc: "Optional single-pass random overwrite + fsync before unlinking the plaintext source. Best-effort on flash due to wear-leveling." },
                { icon: <RefreshCw size={16} color="#3fb950" />, title: "Auto-Lock-on-Eject Alert", desc: "Tracks unlocked drives between refreshes. Toast warning fires if a drive is removed while still unlocked." },
                { icon: <Key size={16} color="#79c0ff" />, title: "Change Password", desc: "Re-wraps the Master Key under a new password without re-encrypting any files. Optional recovery-code rotation." },
                { icon: <Shield size={16} color="#3fb950" />, title: "Atomic Writes", desc: "Every encrypted file and the .drivelock are written to a .tmp + fsync, then os.replace'd — power-loss safe." },
                { icon: <FileText size={16} color="#c9b3ff" />, title: "Password Strength Meter", desc: "Live 5-level meter checking length, uppercase, digits, and symbols while you type." },
                { icon: <Settings size={16} color="#8b949e" />, title: "Persistent Settings", desc: "Toggles for filename obfuscation, secure-wipe, auto-lock-on-eject, and toast notifications stored via QSettings." },
                { icon: <Shield size={16} color="#388bfd" />, title: "Tray + Toast", desc: "QSystemTrayIcon with native Windows balloon notifications for lock/unlock/error events. Right-click for Lock-All." },
                { icon: <Play size={16} color="#3fb950" />, title: "PyInstaller Export", desc: "Includes setup.py to build a single standalone DriveGuard.exe with PyInstaller — no Python required on target." },
              ].map((f, i) => (
                <FeatureCard key={i} icon={f.icon} title={f.title} desc={f.desc} />
              ))}
            </div>
          </div>

          {/* SECURITY NOTES */}
          <div style={{ marginBottom: "36px" }}>
            <SectionTitle icon={<Shield size={15} color="#8b949e" />} title="Security Notes" />
            <div style={{
              background: "#161b22", border: "1px solid #30363d",
              borderRadius: "10px", padding: "20px", marginTop: "14px",
            }}>
              {[
                { color: "#3fb950", text: "AES-256-GCM provides both confidentiality and authenticity — every chunk's 128-bit tag is verified before plaintext is written out." },
                { color: "#3fb950", text: "PBKDF2-SHA256 with 310,000 iterations matches NIST 2023 recommendations and resists offline brute-force on commodity hardware." },
                { color: "#3fb950", text: "Each chunk and each wrapped key uses a fresh 96-bit nonce from secrets.token_bytes — nonce reuse is impossible." },
                { color: "#3fb950", text: "The Master Key is NEVER written to disk in plaintext. .drivelock only contains two AES-GCM-wrapped copies (one per credential)." },
                { color: "#3fb950", text: "Filename obfuscation (when enabled) replaces on-disk names with random 32-hex stems; the real name is encrypted into the file header." },
                { color: "#3fb950", text: "Atomic .tmp + fsync + os.replace means an interrupted lock/unlock leaves either the original or the encrypted file — never both half-written." },
                { color: "#d29922", text: "Secure-wipe is single-pass random overwrite — best-effort on flash/SSD where wear-leveling may relocate writes; do not rely on it as forensic erasure." },
                { color: "#d29922", text: "If you LOSE BOTH the password AND the recovery code, the data is unrecoverable. Store the recovery code offline (printed or password-manager)." },
                { color: "#da3633", text: "Anyone holding the recovery code can unlock the drive — treat it with the same care as the password itself." },
              ].map((n, i) => (
                <div key={i} style={{ display: "flex", gap: "10px", marginBottom: i < 8 ? "10px" : 0 }}>
                  <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: n.color, marginTop: "6px", flexShrink: 0 }} />
                  <span style={{ color: "#8b949e", fontSize: "12px", lineHeight: "1.6" }}>{n.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* App window preview */}
          <div style={{ marginBottom: "24px" }}>
            <SectionTitle icon={<Play size={15} color="#8b949e" />} title="Application Preview" />
            <AppPreview />
          </div>
        </div>
      )}

      {/* ── Tab: Code ── */}
      {activeTab === "code" && (
        <div style={{ padding: "24px 32px", maxWidth: "1100px", margin: "0 auto" }}>
          <div style={{ display: "flex", gap: "16px" }}>
            {/* File tree */}
            <div style={{
              width: "200px", flexShrink: 0, background: "#161b22",
              border: "1px solid #30363d", borderRadius: "10px",
              overflow: "hidden", alignSelf: "flex-start",
            }}>
              <div style={{
                padding: "10px 14px", borderBottom: "1px solid #30363d",
                color: "#8b949e", fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em",
              }}>FILES</div>
              {Object.entries(FILES).map(([name]) => (
                <button key={name}
                  type="button"
                  onClick={() => { setActiveFile(name); setShowFull(false); }}
                  style={{
                    width: "100%", padding: "9px 14px", border: "none",
                    background: activeFile === name ? "#1c2333" : "transparent",
                    color: activeFile === name ? "#f0f6fc" : "#8b949e",
                    borderLeft: activeFile === name ? "2px solid #1f6feb" : "2px solid transparent",
                    fontSize: "12px", fontWeight: 500, cursor: "pointer",
                    textAlign: "left", display: "flex", alignItems: "center", gap: "7px",
                    transition: "all 0.1s",
                  }}
                  onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (activeFile !== name) { (e.currentTarget as HTMLButtonElement).style.background = "#1c2333"; (e.currentTarget as HTMLButtonElement).style.color = "#f0f6fc"; } }}
                  onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { if (activeFile !== name) { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = "#8b949e"; } }}
                >
                  <FileCode size={12} /> {name}
                </button>
              ))}
            </div>

            {/* Code pane */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                background: "#161b22", border: "1px solid #30363d",
                borderRadius: "10px", overflow: "hidden",
              }}>
                {/* toolbar */}
                <div style={{
                  padding: "10px 16px", background: "#0d1117",
                  borderBottom: "1px solid #30363d",
                  display: "flex", alignItems: "center", gap: "10px",
                }}>
                  <FileCode size={14} color="#8b949e" />
                  <span style={{ color: "#f0f6fc", fontSize: "13px", fontWeight: 600 }}>{activeFile}</span>
                  <span style={{ color: "#6e7681", fontSize: "11px" }}>
                    ({contentLines.length} lines)
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      onClick={copyCode}
                      style={{
                        padding: "5px 10px", borderRadius: "6px",
                        background: copied ? "#1a3d2a" : "#21262d",
                        border: `1px solid ${copied ? "#2ea043" : "#30363d"}`,
                        color: copied ? "#3fb950" : "#8b949e",
                        fontSize: "11px", fontWeight: 600, cursor: "pointer",
                        display: "flex", alignItems: "center", gap: "4px",
                      }}
                    >
                      {copied ? <><CheckCircle size={11} /> Copied!</> : <><Copy size={11} /> Copy</>}
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadFile(activeFile, activeContent)}
                      style={{
                        padding: "5px 10px", borderRadius: "6px",
                        background: "#1f3a5f", border: "1px solid #1f6feb",
                        color: "#79c0ff", fontSize: "11px", fontWeight: 600,
                        cursor: "pointer", display: "flex", alignItems: "center", gap: "4px",
                      }}
                    >
                      <Download size={11} /> Download
                    </button>
                  </div>
                </div>
                {/* code */}
                <pre style={{
                  margin: 0, padding: "16px 20px",
                  background: "#0d1117", color: "#c9d1d9",
                  fontSize: "12px", lineHeight: "1.6",
                  fontFamily: "Consolas,'Courier New',monospace",
                  overflowX: "auto",
                  maxHeight: showFull ? "none" : "520px",
                  overflowY: showFull ? "visible" : "hidden",
                }}>
                  {displayLines}
                </pre>
                {!showFull && contentLines.length > 60 && (
                  <div style={{
                    padding: "10px", background: "linear-gradient(0deg, #0d1117, transparent)",
                    borderTop: "1px solid #30363d", textAlign: "center",
                  }}>
                    <div style={{ color: "#8b949e", fontSize: "11px", marginBottom: "8px" }}>
                      … {contentLines.length - 60} more lines hidden
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowFull(true)}
                      style={{
                        padding: "7px 16px", borderRadius: "6px",
                        background: "#21262d", border: "1px solid #30363d",
                        color: "#8b949e", fontSize: "12px", cursor: "pointer",
                        display: "inline-flex", alignItems: "center", gap: "5px",
                      }}
                    >
                      <Eye size={12} /> Show Full File
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Install ── */}
      {activeTab === "install" && (
        <div style={{ padding: "32px", maxWidth: "800px", margin: "0 auto" }}>
          <SectionTitle icon={<Terminal size={15} color="#8b949e" />} title="Installation & Usage" />

          <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "20px" }}>
            {[
              {
                step: "1",
                title: "Download all files",
                color: "#388bfd",
                content: (
                  <div>
                    <p style={{ color: "#8b949e", fontSize: "12px", margin: "0 0 12px" }}>
                      Click the button below to download the complete package (6 files, including README.md).
                    </p>
                    <button
                      type="button"
                      onClick={downloadAll}
                      disabled={downloading}
                      style={{
                        padding: "10px 20px", borderRadius: "8px",
                        background: "linear-gradient(135deg, #238636, #2ea043)",
                        border: "none", color: "#fff", fontSize: "13px",
                        fontWeight: 700, cursor: downloading ? "not-allowed" : "pointer",
                        display: "flex", alignItems: "center", gap: "6px",
                        opacity: downloading ? 0.65 : 1, transition: "opacity 0.2s",
                      }}
                      onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => { if (!downloading) e.currentTarget.style.opacity = "0.88"; }}
                      onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => { if (!downloading) e.currentTarget.style.opacity = "1"; }}
                    >
                      <Download size={14} />
                      {downloading ? "Generating ZIP…" : "Download All Files"}
                    </button>
                  </div>
                ),
              },
              {
                step: "2",
                title: "Install Python 3.10+",
                color: "#d29922",
                content: (
                  <div>
                    <p style={{ color: "#8b949e", fontSize: "12px", margin: "0 0 10px" }}>
                      Download from <a href="https://python.org" target="_blank" rel="noreferrer"
                        style={{ color: "#388bfd" }}>python.org</a>. Make sure to check{" "}
                      <strong style={{ color: "#f0f6fc" }}>"Add Python to PATH"</strong> during install.
                    </p>
                    <Code>python --version</Code>
                  </div>
                ),
              },
              {
                step: "3",
                title: "Install dependencies",
                color: "#3fb950",
                content: (
                  <div>
                    <p style={{ color: "#8b949e", fontSize: "12px", margin: "0 0 10px" }}>
                      Double-click <strong style={{ color: "#f0f6fc" }}>install.bat</strong> OR run in terminal:
                    </p>
                    <Code>pip install PyQt5 cryptography psutil</Code>
                  </div>
                ),
              },
              {
                step: "4",
                title: "Run DriveGuard",
                color: "#c9b3ff",
                content: (
                  <div>
                    <p style={{ color: "#8b949e", fontSize: "12px", margin: "0 0 10px" }}>
                      Double-click <strong style={{ color: "#f0f6fc" }}>run.bat</strong> or:
                    </p>
                    <Code>python driveguard.py</Code>
                    <p style={{ color: "#6e7681", fontSize: "11px", margin: "10px 0 0" }}>
                      Run as Administrator for full access to all drives.
                    </p>
                  </div>
                ),
              },
              {
                step: "5",
                title: "(Optional) Build standalone .exe",
                color: "#8b949e",
                content: (
                  <div>
                    <Code>pip install pyinstaller{"\n"}python setup.py</Code>
                    <p style={{ color: "#6e7681", fontSize: "11px", margin: "10px 0 0" }}>
                      Output: <code style={{ color: "#f0f6fc" }}>dist/DriveGuard.exe</code> — no Python needed on target machine.
                    </p>
                  </div>
                ),
              },
            ].map(({ step, title, color, content }) => (
              <div key={step} style={{
                background: "#161b22", border: "1px solid #30363d",
                borderRadius: "10px", overflow: "hidden",
              }}>
                <div style={{
                  padding: "14px 20px", borderBottom: "1px solid #30363d",
                  display: "flex", alignItems: "center", gap: "12px",
                  background: "#0d1117",
                }}>
                  <div style={{
                    width: "28px", height: "28px", borderRadius: "50%",
                    background: color + "22", border: `1px solid ${color}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color, fontSize: "12px", fontWeight: 800, flexShrink: 0,
                  }}>{step}</div>
                  <span style={{ color: "#f0f6fc", fontSize: "14px", fontWeight: 600 }}>{title}</span>
                </div>
                <div style={{ padding: "16px 20px" }}>{content}</div>
              </div>
            ))}
          </div>

          {/* How to use */}
          <div style={{ marginTop: "32px" }}>
            <SectionTitle icon={<Play size={15} color="#8b949e" />} title="How to Use" />
            <div style={{
              background: "#161b22", border: "1px solid #30363d",
              borderRadius: "10px", padding: "20px", marginTop: "14px",
            }}>
              {[
                { icon: "1.", text: "Plug in your USB drive — DriveGuard detects it instantly via the WM_DEVICECHANGE listener." },
                { icon: "2.", text: 'Select the drive, then click "Set Password & Encrypt" (new drive) or "Lock Drive" (re-lock an existing one).' },
                { icon: "3.", text: "Enter a strong password (live strength meter), confirm, and acknowledge the encryption warning." },
                { icon: "4.", text: "A 24-char recovery code is shown ONCE — copy it or save to file before continuing. This is your only fallback if you forget the password." },
                { icon: "5.", text: "DriveGuard encrypts every file in 1 MiB chunks with AES-256-GCM. Filenames are obfuscated and originals secure-wiped if those settings are on." },
                { icon: "6.", text: 'To unlock, click "Unlock Drive" and enter the password. To rotate it, use "Change Password" — files are not re-encrypted, only the wrapped key is.' },
                { icon: "7.", text: 'Forgot password? Click "Recovery", enter the 24-char code, and you can optionally set a new password (which auto-rotates the recovery code).' },
              ].map((s, i) => (
                <div key={i} style={{ display: "flex", gap: "12px", marginBottom: i < 6 ? "12px" : 0 }}>
                  <span style={{
                    color: "#388bfd", fontSize: "12px", fontWeight: 700,
                    flexShrink: 0, marginTop: "2px",
                  }}>{s.icon}</span>
                  <span style={{ color: "#8b949e", fontSize: "12px", lineHeight: "1.6" }}>{s.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{
        borderTop: "1px solid #30363d", background: "#161b22",
        padding: "20px 32px", marginTop: "40px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Shield size={14} color="#388bfd" />
          <span style={{ color: "#8b949e", fontSize: "12px" }}>
            DriveGuard v1.2.0 — AES-256-GCM Encryption Engine
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <Pill text="Python 3.10+" color="#3fb950" bg="#1a3d2a" />
          <Pill text="PyQt5" color="#388bfd" bg="#1f3a5f" />
          <Pill text="cryptography" color="#c9b3ff" bg="#2d1b69" />
          <Pill text="psutil" color="#d29922" bg="#2d1e00" />
        </div>
      </div>

    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      {icon}
      <span style={{ color: "#f0f6fc", fontSize: "15px", fontWeight: 700 }}>{title}</span>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre style={{
      margin: 0, padding: "12px 16px",
      background: "#0d1117", border: "1px solid #30363d",
      borderRadius: "8px", color: "#79c0ff",
      fontFamily: "Consolas,'Courier New',monospace",
      fontSize: "12px", lineHeight: "1.7", overflowX: "auto",
    }}>{children}</pre>
  );
}

// ── App Preview ───────────────────────────────────────────────────────────────

function AppPreview() {
  return (
    <div style={{
      marginTop: "14px", background: "#0d1117",
      border: "1px solid #30363d", borderRadius: "12px",
      overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
    }}>
      {/* Title bar */}
      <div style={{
        height: "36px", background: "#1c2333",
        borderBottom: "1px solid #30363d",
        display: "flex", alignItems: "center",
        padding: "0 12px", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Shield size={13} color="#388bfd" />
          <span style={{ color: "#8b949e", fontSize: "12px" }}>
            DriveGuard v1.2.0 — AES-256 USB Drive Encryption
          </span>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          {["#30363d", "#30363d", "#da3633"].map((c, i) => (
            <div key={i} style={{ width: "12px", height: "12px", borderRadius: "50%", background: c }} />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", height: "380px" }}>
        {/* Sidebar */}
        <div style={{
          width: "190px", background: "#161b22",
          borderRight: "1px solid #30363d", padding: "16px",
          display: "flex", flexDirection: "column", gap: "16px",
        }}>
          <div>
            <div style={{ color: "#f0f6fc", fontSize: "15px", fontWeight: 800, marginBottom: "2px" }}>
              DriveGuard
            </div>
            <div style={{ color: "#8b949e", fontSize: "10px" }}>AES-256 Encryption</div>
          </div>
          <div style={{ border: "1px solid #30363d" }} />
          <div>
            <div style={{ color: "#6e7681", fontSize: "9px", fontWeight: 700, marginBottom: "8px", letterSpacing: "0.1em" }}>
              DRIVE STATUS
            </div>
            {[
              { l: "Total drives:", v: "0", c: "#8b949e" },
              { l: "Encrypted:", v: "0", c: "#da3633" },
              { l: "Unlocked:", v: "0", c: "#3fb950" },
              { l: "Unprotected:", v: "0", c: "#d29922" },
            ].map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                <span style={{ color: "#6e7681", fontSize: "11px" }}>{s.l}</span>
                <span style={{ color: s.c, fontSize: "11px", fontWeight: 700 }}>{s.v}</span>
              </div>
            ))}
          </div>
          <div style={{ border: "1px solid #30363d" }} />
          <div>
            <div style={{ color: "#6e7681", fontSize: "9px", fontWeight: 700, marginBottom: "6px", letterSpacing: "0.1em" }}>
              ENCRYPTION
            </div>
            {[
              "Algorithm: AES-256-GCM",
              "KDF: PBKDF2-SHA256",
              "Iterations: 310,000",
              "Chunks: 1 MiB streaming",
              "Auth Tag: 128-bit",
              "Recovery: 24-char code",
            ].map((t, i) => (
              <div key={i} style={{ color: "#6e7681", fontSize: "10px", marginBottom: "3px" }}>{t}</div>
            ))}
          </div>
        </div>

        {/* Main */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          {/* Header */}
          <div style={{
            height: "48px", borderBottom: "1px solid #30363d",
            display: "flex", alignItems: "center",
            padding: "0 16px", justifyContent: "space-between",
          }}>
            <span style={{ color: "#f0f6fc", fontSize: "13px", fontWeight: 700 }}>
              Connected Storage Devices
            </span>
            <button type="button" disabled style={{
              padding: "5px 10px", borderRadius: "6px",
              background: "#21262d", border: "1px solid #30363d",
              color: "#484f58", fontSize: "11px", fontWeight: 700, cursor: "not-allowed",
            }}>
              Lock All
            </button>
          </div>

          {/* Drive list — showing a mock drive as in the screenshot */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
            <div style={{
              background: "#0d1117", border: "1px solid #30363d", borderRadius: "8px",
              padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px",
              marginBottom: "8px", position: "relative",
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "#f0f6fc", fontSize: "13px", fontWeight: 700 }}>Flash USB</span>
                  <span style={{ color: "#8b949e", fontSize: "11px" }}>(D:) • exFAT</span>
                </div>
                <div style={{ color: "#8b949e", fontSize: "11px", marginTop: "2px" }}>
                  38.0 GB used of 250.0 GB (15.2%)
                </div>
              </div>
              <div style={{
                background: "#2d1e00", color: "#e3b341", border: "1px solid #e3b341",
                borderRadius: "10px", padding: "3px 12px", fontSize: "10px", fontWeight: 800,
              }}>
                UNPROTECTED
              </div>
            </div>
          </div>

          {/* Action buttons — improved visibility */}
          <div style={{
            height: "74px", background: "#161b22", borderTop: "1px solid #30363d",
            display: "flex", alignItems: "center", padding: "0 20px", gap: "8px",
          }}>
            {[
              { txt: "Lock Drive", icon: <Lock size={12} />, bg: "#3d1a1a", col: "#f85149", brd: "#f85149", flex: 2 },
              { txt: "Unlock Drive", icon: <Unlock size={12} />, bg: "#1a3d2a", col: "#3fb950", brd: "#3fb950", flex: 2 },
              { txt: "Recovery", icon: <Key size={12} />, bg: "#2d1e00", col: "#e3b341", brd: "#e3b341", flex: 2 },
              { txt: "Change Password", icon: <KeySquare size={12} />, bg: "#21262d", col: "#8b949e", brd: "#30363d", flex: 2 },
              { txt: "Refresh", icon: <RefreshCw size={12} />, bg: "#21262d", col: "#8b949e", brd: "#30363d", flex: 1.5 },
            ].map((b, i) => (
              <button key={i} type="button" style={{
                flex: b.flex, padding: "10px", borderRadius: "8px",
                background: b.bg, border: `1px solid ${b.brd}`,
                color: b.col, fontSize: "12px", fontWeight: 700, cursor: "pointer",
                transition: "all 0.15s",
              }}>
                {b.txt}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div style={{
        height: "22px", background: "#1f6feb",
        display: "flex", alignItems: "center", padding: "0 12px",
      }}>
        <span style={{ color: "#cae8ff", fontSize: "10px" }}>
          DriveGuard v1.2.0 — AES-256-GCM Engine Ready · WM_DEVICECHANGE active
        </span>
      </div>
    </div>
  );
}
