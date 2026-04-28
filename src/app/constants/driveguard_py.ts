export const DRIVEGUARD_PY = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DriveGuard v1.2 — Real USB Drive Encryption Tool
AES-256-GCM + PBKDF2-SHA256
Master-key model · Recovery codes · Filename obfuscation · Secure wipe
Native Windows WM_DEVICECHANGE listener (no polling lag for ejects).

Requirements:
    pip install PyQt5 cryptography psutil
"""

import sys, os, json, struct, hashlib, secrets, base64, queue, ctypes
from ctypes import wintypes
from pathlib import Path
from typing import Optional, List, Tuple, Dict

# ── Dependency checks ─────────────────────────────────────────────────────────
missing = []
try:
    from PyQt5.QtWidgets import (
        QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
        QPushButton, QLabel, QListWidget, QListWidgetItem, QProgressBar,
        QDialog, QLineEdit, QMessageBox, QFrame, QCheckBox,
        QAbstractItemView, QSystemTrayIcon, QMenu, QAction, QPlainTextEdit,
        QFileDialog,
    )
    from PyQt5.QtCore import Qt, QThread, pyqtSignal, QTimer, QSize, QSettings
    from PyQt5.QtGui import QFont, QColor, QPalette, QIcon, QPixmap, QPainter, QBrush
except ImportError:
    missing.append("PyQt5")

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.backends import default_backend
except ImportError:
    missing.append("cryptography")

try:
    import psutil
except ImportError:
    missing.append("psutil")

if missing:
    print(f"ERROR: Missing packages: {', '.join(missing)}")
    print(f"Install with:  pip install {' '.join(missing)}")
    sys.exit(1)


# ═══════════════════════════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════
APP_NAME       = "DriveGuard"
APP_VERSION    = "1.2.0"
LOCK_FILENAME  = ".drivelock"
ENC_EXT        = ".dge"
MAGIC          = b"DGUARD3"
FORMAT_VERSION = 3
SALT_BYTES     = 32
NONCE_BYTES    = 12
KEY_BYTES      = 32
KDF_ITERS      = 310_000
CHUNK_SIZE     = 1024 * 1024           # 1 MiB
WIPE_CHUNK     = 1024 * 1024
FLAG_OBFUSCATE = 0x01

# Win32
WM_DEVICECHANGE          = 0x0219
DBT_DEVICEARRIVAL        = 0x8000
DBT_DEVICEQUERYREMOVE    = 0x8001
DBT_DEVICEREMOVEPENDING  = 0x8003
DBT_DEVICEREMOVECOMPLETE = 0x8004
DBT_DEVNODES_CHANGED     = 0x0007
DBT_DEVTYP_VOLUME        = 0x00000002

SKIP_FILES = frozenset({
    LOCK_FILENAME, "autorun.inf", "desktop.ini", "thumbs.db", ".ds_store",
})
SKIP_DIRS = frozenset({
    "System Volume Information", "$RECYCLE.BIN", "RECYCLER", ".Trashes",
})

C = {
    "bg0":"#0d1117","bg1":"#161b22","bg2":"#21262d","bd":"#30363d",
    "txt":"#f0f6fc","muted":"#8b949e","blue":"#1f6feb","green":"#3fb950",
    "red":"#f85149","amber":"#e3b341",
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECURE WIPE
# ═══════════════════════════════════════════════════════════════════════════════
def secure_wipe(path: Path) -> bool:
    """
    Single-pass random-byte overwrite + fsync, then unlink.
    Note: on flash/SSD with wear-leveling this is best-effort, not guaranteed.
    """
    try:
        size = path.stat().st_size
        with open(path, "r+b", buffering=0) as f:
            written = 0
            while written < size:
                chunk = secrets.token_bytes(min(WIPE_CHUNK, size - written))
                f.write(chunk); written += len(chunk)
            f.flush()
            try: os.fsync(f.fileno())
            except OSError: pass
        path.unlink()
        return True
    except OSError:
        try: path.unlink()
        except OSError: pass
        return False


# ═══════════════════════════════════════════════════════════════════════════════
# CRYPTO ENGINE
# ═══════════════════════════════════════════════════════════════════════════════
class Engine:
    """
    Master-key design with two wrapped copies (password + recovery).
    File format v3:
        MAGIC(7) | VERSION(1) | FLAGS(1) | CHUNK_SIZE(4 LE)
        | NAME_NONCE(12) | NAME_LEN(2 LE)  -- length includes 16-byte GCM tag
        | NAME_CT(NAME_LEN)
        | { DATA_NONCE(12) | CT_chunk(<=CHUNK_SIZE)+TAG(16) } *
    """

    @staticmethod
    def _pbkdf2(secret: str, salt: bytes) -> bytes:
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=KEY_BYTES,
                         salt=salt, iterations=KDF_ITERS, backend=default_backend())
        return kdf.derive(secret.encode("utf-8"))

    @staticmethod
    def _wrap(kek: bytes, mk: bytes) -> dict:
        nonce = secrets.token_bytes(NONCE_BYTES)
        ct    = AESGCM(kek).encrypt(nonce, mk, b"DG-MK")
        return {"nonce": base64.b64encode(nonce).decode(),
                "ct":    base64.b64encode(ct).decode()}

    @staticmethod
    def _unwrap(kek: bytes, wrapped: dict) -> Optional[bytes]:
        try:
            return AESGCM(kek).decrypt(
                base64.b64decode(wrapped["nonce"]),
                base64.b64decode(wrapped["ct"]),
                b"DG-MK")
        except Exception:
            return None

    @staticmethod
    def generate_recovery_code() -> str:
        raw = secrets.token_bytes(15)
        b32 = base64.b32encode(raw).decode().rstrip("=")
        return "-".join(b32[i:i+4] for i in range(0, 24, 4))

    @staticmethod
    def normalize_recovery_code(code: str) -> str:
        return "".join(c for c in code.upper() if c.isalnum())

    @staticmethod
    def make_metadata(password: str) -> Tuple[dict, str]:
        mk        = secrets.token_bytes(KEY_BYTES)
        salt_pwd  = secrets.token_bytes(SALT_BYTES)
        salt_rec  = secrets.token_bytes(SALT_BYTES)
        kek_pwd   = Engine._pbkdf2(password, salt_pwd)
        rec_code  = Engine.generate_recovery_code()
        kek_rec   = Engine._pbkdf2(Engine.normalize_recovery_code(rec_code), salt_rec)
        meta = {
            "app":APP_NAME, "version":APP_VERSION, "format":FORMAT_VERSION,
            "algorithm":"AES-256-GCM", "kdf":"PBKDF2-HMAC-SHA256",
            "iterations":KDF_ITERS, "chunk_size":CHUNK_SIZE,
            "salt_pwd":   base64.b64encode(salt_pwd).decode(),
            "salt_rec":   base64.b64encode(salt_rec).decode(),
            "wrapped_pwd":Engine._wrap(kek_pwd, mk),
            "wrapped_rec":Engine._wrap(kek_rec, mk),
        }
        return meta, rec_code

    @staticmethod
    def rewrap_password(meta: dict, mk: bytes, new_password: str) -> dict:
        salt = secrets.token_bytes(SALT_BYTES)
        kek  = Engine._pbkdf2(new_password, salt)
        meta = dict(meta)
        meta["salt_pwd"]    = base64.b64encode(salt).decode()
        meta["wrapped_pwd"] = Engine._wrap(kek, mk)
        return meta

    @staticmethod
    def rewrap_recovery(meta: dict, mk: bytes) -> Tuple[dict, str]:
        salt = secrets.token_bytes(SALT_BYTES)
        code = Engine.generate_recovery_code()
        kek  = Engine._pbkdf2(Engine.normalize_recovery_code(code), salt)
        meta = dict(meta)
        meta["salt_rec"]    = base64.b64encode(salt).decode()
        meta["wrapped_rec"] = Engine._wrap(kek, mk)
        return meta, code

    @staticmethod
    def unlock_with_password(meta: dict, password: str) -> Optional[bytes]:
        salt = base64.b64decode(meta["salt_pwd"])
        return Engine._unwrap(Engine._pbkdf2(password, salt), meta["wrapped_pwd"])

    @staticmethod
    def unlock_with_recovery(meta: dict, code: str) -> Optional[bytes]:
        if "wrapped_rec" not in meta: return None
        salt = base64.b64decode(meta["salt_rec"])
        return Engine._unwrap(Engine._pbkdf2(Engine.normalize_recovery_code(code), salt),
                              meta["wrapped_rec"])

    # ── File-level streaming crypto ───────────────────────────────────────────
    @staticmethod
    def encrypt_file(path: Path, key: bytes, *, obfuscate: bool, wipe: bool) -> bool:
        original_name = path.name.encode("utf-8")
        if len(original_name) > 60_000:
            return False  # absurdly long name
        # Pick on-disk encrypted name
        if obfuscate:
            enc_stem = secrets.token_hex(16)
        else:
            enc_stem = path.name
        dst = path.parent / (enc_stem + ENC_EXT)
        # avoid collisions
        while dst.exists():
            enc_stem = secrets.token_hex(16); dst = path.parent / (enc_stem + ENC_EXT)
        tmp = dst.with_suffix(dst.suffix + ".part")
        try:
            aes = AESGCM(key)
            flags = FLAG_OBFUSCATE if obfuscate else 0
            name_nonce = secrets.token_bytes(NONCE_BYTES)
            name_ct    = aes.encrypt(name_nonce, original_name, b"DG-NAME")
            with open(path, "rb") as src, open(tmp, "wb") as out:
                out.write(MAGIC)
                out.write(bytes([FORMAT_VERSION, flags]))
                out.write(struct.pack("<I", CHUNK_SIZE))
                out.write(name_nonce)
                out.write(struct.pack("<H", len(name_ct)))
                out.write(name_ct)
                while True:
                    chunk = src.read(CHUNK_SIZE)
                    if not chunk: break
                    nonce = secrets.token_bytes(NONCE_BYTES)
                    out.write(nonce)
                    out.write(aes.encrypt(nonce, chunk, b"DG-DATA"))
                out.flush()
                try: os.fsync(out.fileno())
                except OSError: pass
            os.replace(tmp, dst)
            try:
                if not dst.exists() or dst.stat().st_size == 0:
                    raise OSError("destination missing or empty after rename")
            except OSError:
                return False
            if wipe:
                secure_wipe(path)
            else:
                try: path.unlink()
                except OSError: pass
            return True
        except Exception:
            try:
                if tmp.exists(): tmp.unlink()
            except OSError: pass
            return False

    @staticmethod
    def decrypt_file(path: Path, key: bytes) -> bool:
        try:
            aes = AESGCM(key)
            with open(path, "rb") as src:
                if src.read(len(MAGIC)) != MAGIC: return False
                hdr = src.read(2)
                if len(hdr) != 2 or hdr[0] != FORMAT_VERSION: return False
                cs_b = src.read(4)
                if len(cs_b) != 4: return False
                cs = struct.unpack("<I", cs_b)[0]
                name_nonce = src.read(NONCE_BYTES)
                nl_b = src.read(2)
                if len(nl_b) != 2: return False
                name_len = struct.unpack("<H", nl_b)[0]
                name_ct  = src.read(name_len)
                if len(name_ct) != name_len: return False
                try:
                    original_name = aes.decrypt(name_nonce, name_ct, b"DG-NAME").decode("utf-8")
                except Exception:
                    return False

                # Resolve destination — avoid overwriting existing files
                dst = path.parent / original_name
                if dst.exists() and dst != path:
                    stem, dot, ext = original_name.rpartition(".")
                    base = stem if dot else original_name
                    suffix = ("." + ext) if dot else ""
                    i = 1
                    while dst.exists():
                        dst = path.parent / f"{base} ({i}){suffix}"; i += 1

                tmp = dst.with_suffix(dst.suffix + ".part")
                ct_size = cs + 16
                with open(tmp, "wb") as out:
                    while True:
                        nonce = src.read(NONCE_BYTES)
                        if not nonce: break
                        if len(nonce) != NONCE_BYTES: return False
                        ct = src.read(ct_size)
                        if not ct: return False
                        out.write(aes.decrypt(nonce, ct, b"DG-DATA"))
                    out.flush()
                    try: os.fsync(out.fileno())
                    except OSError: pass
            os.replace(tmp, dst)
            try: path.unlink()
            except OSError: pass
            return True
        except Exception:
            try:
                if 'tmp' in locals() and tmp.exists(): tmp.unlink()  # type: ignore
            except OSError: pass
            return False


# ═══════════════════════════════════════════════════════════════════════════════
# ORPHAN RECOVERY  — finds .dge.part files left behind by an interrupted lock
# ═══════════════════════════════════════════════════════════════════════════════
def find_orphan_parts(root: Path) -> List[Path]:
    """Walk a drive and return every *.dge.part file (incomplete encryption)."""
    out: List[Path] = []
    try:
        for p in root.rglob("*.part"):
            if p.is_file() and p.name.endswith(ENC_EXT + ".part"):
                out.append(p)
    except (OSError, PermissionError):
        pass
    return out


def find_orphan_originals(root: Path) -> List[Tuple[Path, Path]]:
    """For each *.dge file, check if the plaintext source still exists alongside.
    Returns (dge_path, original_path) pairs — the original was never deleted,
    likely because the prior run died after rename but before unlink.
    These are SAFE to keep — they're your real files, untouched."""
    out: List[Tuple[Path, Path]] = []
    try:
        for dge in root.rglob("*" + ENC_EXT):
            if dge.name.endswith(".part"): continue
            stem = dge.name[:-len(ENC_EXT)]
            sibling = dge.parent / stem
            if sibling.exists() and sibling.is_file():
                out.append((dge, sibling))
    except (OSError, PermissionError):
        pass
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# LOCK FILE I/O
# ═══════════════════════════════════════════════════════════════════════════════
def write_lockfile(mp: str, meta: dict):
    lk  = Path(mp) / LOCK_FILENAME
    tmp = lk.with_suffix(".tmp")
    data = json.dumps(meta, indent=2).encode("utf-8")
    with open(tmp, "wb") as f:
        f.write(data); f.flush()
        try: os.fsync(f.fileno())
        except OSError: pass
    os.replace(tmp, lk)


# ═══════════════════════════════════════════════════════════════════════════════
# SCANNER
# ═══════════════════════════════════════════════════════════════════════════════
class Scanner:
    @staticmethod
    def get_drives() -> List[dict]:
        result = []
        sysroot = ""
        if sys.platform == "win32":
            sysroot = os.environ.get("SystemDrive", "C:").upper()
        for part in psutil.disk_partitions(all=False):
            try:
                if sys.platform == "win32":
                    if part.mountpoint.upper().startswith(sysroot):
                        continue
                    dtype = ctypes.windll.kernel32.GetDriveTypeW(part.mountpoint)
                    if dtype != 2: continue   # Removable only
                usage = psutil.disk_usage(part.mountpoint)
                lock  = Path(part.mountpoint) / LOCK_FILENAME
                protected = lock.exists()
                locked    = Scanner._is_locked_fast(part.mountpoint, protected)
                result.append({
                    "device":part.device, "mountpoint":part.mountpoint,
                    "fstype":part.fstype or "?",
                    "letter":part.mountpoint.rstrip("/\\\\"),
                    "label":Scanner._label(part.mountpoint, part.device),
                    "total":usage.total, "used":usage.used, "free":usage.free,
                    "percent":usage.percent,
                    "protected":protected, "locked":locked,
                })
            except (PermissionError, OSError, FileNotFoundError):
                continue
        return result

    @staticmethod
    def _label(mp, dev):
        if sys.platform == "win32":
            try:
                buf = ctypes.create_unicode_buffer(261)
                ctypes.windll.kernel32.GetVolumeInformationW(
                    ctypes.c_wchar_p(mp), buf, len(buf),
                    None, None, None, None, 0)
                lbl = buf.value.strip()
                return lbl if lbl else "USB Drive"
            except Exception: pass
        return os.path.basename(dev.rstrip("/\\\\")) or "USB Drive"

    @staticmethod
    def _is_locked_fast(mp: str, protected: bool) -> bool:
        if not protected: return False
        try:
            with os.scandir(mp) as it:
                for entry in it:
                    if entry.is_file() and entry.name.endswith(ENC_EXT):
                        return True
            with os.scandir(mp) as it2:
                for entry in it2:
                    if entry.is_dir() and entry.name not in SKIP_DIRS:
                        try:
                            with os.scandir(entry.path) as it3:
                                for sub in it3:
                                    if sub.is_file() and sub.name.endswith(ENC_EXT):
                                        return True
                        except OSError: continue
        except OSError: pass
        return False

    @staticmethod
    def _walk(mp: str, want_encrypted: bool) -> List[Path]:
        out = []
        for root, dirs, files in os.walk(mp):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                # Always skip orphan/temp artifacts so neither lock nor unlock
                # touches them. Repair button handles those.
                if f.endswith(".part") or f.endswith(".tmp"):
                    continue
                is_enc = f.endswith(ENC_EXT)
                if want_encrypted and is_enc:
                    out.append(Path(root) / f)
                elif (not want_encrypted) and (not is_enc) and f.lower() not in SKIP_FILES:
                    out.append(Path(root) / f)
        return out

    @staticmethod
    def plaintext_files(mp): return Scanner._walk(mp, False)
    @staticmethod
    def encrypted_files(mp): return Scanner._walk(mp, True)


# ═══════════════════════════════════════════════════════════════════════════════
# WORKER
# ═══════════════════════════════════════════════════════════════════════════════
class CryptoWorker(QThread):
    progress = pyqtSignal(int, str)
    job_done = pyqtSignal(bool, str, str)

    def __init__(self):
        super().__init__()
        self.q: "queue.Queue[Optional[tuple]]" = queue.Queue()
        self._stop = False

    def enqueue(self, mp: str, key: bytes, mode: str, opts: dict):
        self.q.put((mp, key, mode, opts))

    def stop(self):
        self._stop = True
        self.q.put(None)

    def run(self):
        while not self._stop:
            job = self.q.get()
            if job is None: return
            mp, key, mode, opts = job
            try:
                if mode == "lock":
                    files, verb = Scanner.plaintext_files(mp), "Encrypting"
                else:
                    files, verb = Scanner.encrypted_files(mp), "Decrypting"
                n = len(files)
                if n == 0:
                    self.job_done.emit(True, "No files to process.", mp); continue
                failed = 0
                for i, fp in enumerate(files):
                    if self._stop: return
                    rel = str(fp).replace(mp, "").lstrip("/\\\\")
                    self.progress.emit(int(i*100/n), f"{verb}: {rel[:60]}")
                    if mode == "lock":
                        ok = Engine.encrypt_file(
                            fp, key,
                            obfuscate=opts.get("obfuscate", False),
                            wipe=opts.get("wipe", False))
                    else:
                        ok = Engine.decrypt_file(fp, key)
                    if not ok: failed += 1
                self.progress.emit(100, "Done!")
                action = "locked" if mode == "lock" else "unlocked"
                msg = (f"Drive {action} — {n} file(s) processed."
                       if not failed else f"Finished with {failed}/{n} error(s).")
                self.job_done.emit(failed == 0, msg, mp)
            except Exception as exc:
                self.job_done.emit(False, str(exc), mp)


# ═══════════════════════════════════════════════════════════════════════════════
# DIALOGS
# ═══════════════════════════════════════════════════════════════════════════════
def _dialog_style(d):
    d.setStyleSheet(f"""
        QDialog {{ background:{C['bg1']}; }}
        QLabel  {{ color:{C['txt']}; font-size:12px; }}
        QLineEdit, QPlainTextEdit {{
            background:{C['bg0']}; color:{C['txt']};
            border:1px solid {C['bd']}; border-radius:6px;
            padding:9px 12px; font-size:13px; font-family:Consolas,monospace;
        }}
        QLineEdit:focus, QPlainTextEdit:focus {{ border-color:{C['blue']}; }}
        QCheckBox {{ color:{C['muted']}; font-size:11px; }}
        QPushButton {{
            background:{C['bg2']}; color:{C['txt']};
            border:1px solid {C['bd']}; border-radius:6px;
            padding:10px 20px; font-size:13px; font-weight:bold;
        }}
        QPushButton:hover {{ background:{C['bd']}; border-color:{C['muted']}; }}
        QPushButton[default="true"] {{ background:{C['blue']}; color:white; border:none; }}
        QPushButton[default="true"]:hover {{ background:#388bfd; }}
    """)


class PwdDialog(QDialog):
    def __init__(self, parent, mode: str, label: str):
        super().__init__(parent)
        self.mode = mode; self.drv = label
        self.password = None; self.old_password = None
        self._ui()

    def _ui(self):
        titles = {"set":"Set Password","enter":"Unlock Drive","change":"Change Password"}
        self.setWindowTitle(f"{titles[self.mode]} — {self.drv}")
        self.setFixedSize(440, {"set":410,"enter":260,"change":420}[self.mode])
        self.setModal(True); _dialog_style(self)
        root = QVBoxLayout(self); root.setSpacing(12); root.setContentsMargins(24,24,24,24)
        ico  = {"set":"","enter":"","change":""}[self.mode]
        verb = {"set":"Encrypt & Lock Drive","enter":"Unlock Drive","change":"Change Password"}[self.mode]
        t = QLabel(f"{ico}  {verb}")
        t.setStyleSheet(f"font-size:16px;font-weight:bold;color:{C['txt']};")
        root.addWidget(t)
        root.addWidget(QLabel(f"Drive: {self.drv}"))
        if self.mode == "set":
            warn = QLabel("️  Files will be encrypted with AES-256-GCM.\\n"
                          "    A recovery code will be shown after — save it!")
            warn.setWordWrap(True)
            warn.setStyleSheet("background:#2d1e00;color:#d29922;border:1px solid #9e6a03;"
                               "border-radius:6px;padding:10px;font-size:11px;")
            root.addWidget(warn)
        if self.mode == "change":
            root.addWidget(QLabel("Current Password:"))
            self.opwd = QLineEdit(); self.opwd.setEchoMode(QLineEdit.Password)
            root.addWidget(self.opwd)
        root.addWidget(QLabel("Password:" if self.mode == "enter" else "New Password:"))
        self.pwd = QLineEdit(); self.pwd.setEchoMode(QLineEdit.Password)
        self.pwd.setPlaceholderText("Enter a strong password…")
        self.pwd.textChanged.connect(self._strength); root.addWidget(self.pwd)
        if self.mode in ("set","change"):
            self.bar = QProgressBar(); self.bar.setRange(0,5); self.bar.setValue(0)
            self.bar.setTextVisible(False); self.bar.setFixedHeight(8)
            self.slbl = QLabel("Strength: —")
            self.slbl.setStyleSheet(f"color:{C['muted']};font-size:11px;")
            root.addWidget(self.bar); root.addWidget(self.slbl)
            root.addWidget(QLabel("Confirm Password:"))
            self.cpwd = QLineEdit(); self.cpwd.setEchoMode(QLineEdit.Password)
            root.addWidget(self.cpwd)
        shw = QCheckBox("Show password")
        def _toggle(s):
            m = QLineEdit.Normal if s else QLineEdit.Password
            self.pwd.setEchoMode(m)
            if hasattr(self, "cpwd"): self.cpwd.setEchoMode(m)
            if hasattr(self, "opwd"): self.opwd.setEchoMode(m)
        shw.stateChanged.connect(_toggle)
        root.addWidget(shw)
        bl = QHBoxLayout(); bl.setSpacing(8)
        cancel = QPushButton("Cancel")
        cancel.setStyleSheet(f"QPushButton{{background:transparent;color:{C['muted']};"
                             f"border:1px solid {C['bd']};}}")
        cancel.clicked.connect(self.reject)
        ok_label = {"set":" Encrypt & Lock","enter":" Unlock","change":" Change Password"}[self.mode]
        ok = QPushButton(ok_label)
        ok.setStyleSheet(f"QPushButton{{background:{C['blue']};color:white;border:none;}}"
                         f"QPushButton:hover{{background:#388bfd;}}")
        ok.clicked.connect(self._ok); ok.setDefault(True)
        bl.addWidget(cancel); bl.addWidget(ok); root.addLayout(bl)
        self.pwd.setFocus()

    def _strength(self, _t):
        if self.mode == "enter": return
        s, lbl, col = self._score(self.pwd.text())
        self.bar.setValue(s)
        self.bar.setStyleSheet(
            f"QProgressBar{{background:{C['bg2']};border:none;border-radius:3px;}}"
            f"QProgressBar::chunk{{background:{col};border-radius:3px;}}")
        self.slbl.setText(f"Strength: {lbl}")
        self.slbl.setStyleSheet(f"color:{col};font-size:11px;")

    def _score(self, p):
        s = 0
        if len(p) >= 8:  s += 1
        if len(p) >= 12: s += 1
        if any(c.isupper() for c in p): s += 1
        if any(c.isdigit() for c in p): s += 1
        if any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?" for c in p): s += 1
        lbl = {0:"—",1:"Very Weak",2:"Weak",3:"Fair",4:"Strong",5:"Very Strong"}[s]
        col = {0:C["bd"],1:C["red"],2:C["amber"],3:"#e3b341",4:C["green"],5:"#238636"}[s]
        return s, lbl, col

    def _ok(self):
        p = self.pwd.text()
        if not p:
            QMessageBox.warning(self,"Error","Password cannot be empty."); return
        if self.mode in ("set","change"):
            if len(p) < 6:
                QMessageBox.warning(self,"Weak","Use at least 6 characters."); return
            if p != self.cpwd.text():
                QMessageBox.warning(self,"Mismatch","Passwords do not match."); return
        if self.mode == "change":
            self.old_password = self.opwd.text()
            if not self.old_password:
                QMessageBox.warning(self,"Error","Enter current password."); return
        self.password = p; self.accept()


class RecoveryShowDialog(QDialog):
    def __init__(self, parent, code: str, drive_label: str):
        super().__init__(parent); self.code = code; self.drv = drive_label
        self.setWindowTitle(" Recovery Code"); self.setFixedSize(520, 380)
        self.setModal(True); _dialog_style(self)
        root = QVBoxLayout(self); root.setSpacing(12); root.setContentsMargins(24,24,24,24)
        t = QLabel("  Save Your Recovery Code")
        t.setStyleSheet(f"font-size:18px;font-weight:bold;color:{C['txt']};")
        root.addWidget(t)
        root.addWidget(QLabel(f"Drive: {drive_label}"))
        warn = QLabel("This code can unlock your drive if you forget the password.\\n"
                      "Store it somewhere SAFE and OFFLINE.\\n"
                      "Anyone with this code can access your data!")
        warn.setWordWrap(True)
        warn.setStyleSheet("background:#3d1a1a;color:#f85149;border:1px solid #da3633;"
                           "border-radius:6px;padding:12px;font-size:12px;")
        root.addWidget(warn)
        box = QPlainTextEdit(); box.setReadOnly(True); box.setPlainText(code); box.setFixedHeight(70)
        box.setStyleSheet(box.styleSheet() +
            f"QPlainTextEdit{{font-size:18px;font-weight:bold;color:{C['green']};letter-spacing:2px;}}")
        root.addWidget(box)
        bl = QHBoxLayout()
        copy = QPushButton(" Copy"); copy.clicked.connect(self._copy)
        copy.setStyleSheet(f"QPushButton{{background:{C['bg2']};color:{C['txt']};border:1px solid {C['bd']};}}")
        save = QPushButton(" Save to File"); save.clicked.connect(self._save)
        save.setStyleSheet(f"QPushButton{{background:{C['bg2']};color:{C['txt']};border:1px solid {C['bd']};}}")
        ok = QPushButton("  I've Saved It")
        ok.setStyleSheet(f"QPushButton{{background:{C['green']};color:white;border:none;}}")
        ok.clicked.connect(self._confirm); ok.setDefault(True)
        bl.addWidget(copy); bl.addWidget(save); bl.addStretch(); bl.addWidget(ok)
        root.addLayout(bl)

    def _copy(self):
        QApplication.clipboard().setText(self.code)
        QMessageBox.information(self,"Copied","Recovery code copied to clipboard.")

    def _save(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "Save Recovery Code", f"DriveGuard-Recovery-{self.drv}.txt",
            "Text files (*.txt)")
        if not path: return
        try:
            import datetime
            Path(path).write_text(
                f"DriveGuard Recovery Code\\nDrive: {self.drv}\\n"
                f"Date: {datetime.datetime.now().isoformat(timespec='seconds')}\\n\\n"
                f"{self.code}\\n\\nKeep this file safe and offline.\\n",
                encoding="utf-8")
            QMessageBox.information(self,"Saved",f"Saved to:\\n{path}")
        except OSError as e:
            QMessageBox.critical(self,"Error",str(e))

    def _confirm(self):
        ok = QMessageBox.question(self,"Confirm",
            "Have you saved the recovery code?\\nIt will NOT be shown again.",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if ok == QMessageBox.Yes: self.accept()


class RecoveryUseDialog(QDialog):
    def __init__(self, parent, drive_label: str):
        super().__init__(parent); self.code = None
        self.setWindowTitle(f" Recovery Unlock — {drive_label}")
        self.setFixedSize(440, 240); self.setModal(True); _dialog_style(self)
        root = QVBoxLayout(self); root.setSpacing(12); root.setContentsMargins(24,24,24,24)
        t = QLabel("  Recovery Unlock")
        t.setStyleSheet(f"font-size:16px;font-weight:bold;color:{C['txt']};")
        root.addWidget(t)
        root.addWidget(QLabel("Enter your 24-character recovery code:"))
        self.fld = QLineEdit(); self.fld.setPlaceholderText("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX")
        root.addWidget(self.fld)
        bl = QHBoxLayout()
        cancel = QPushButton("Cancel"); cancel.clicked.connect(self.reject)
        cancel.setStyleSheet(f"QPushButton{{background:transparent;color:{C['muted']};border:1px solid {C['bd']};}}")
        ok = QPushButton(" Unlock with Code"); ok.clicked.connect(self._ok); ok.setDefault(True)
        ok.setStyleSheet(f"QPushButton{{background:{C['amber']};color:white;border:none;}}")
        bl.addWidget(cancel); bl.addWidget(ok); root.addLayout(bl)

    def _ok(self):
        c = Engine.normalize_recovery_code(self.fld.text())
        if len(c) != 24:
            QMessageBox.warning(self,"Invalid","Code must be 24 alphanumeric characters."); return
        self.code = c; self.accept()


# ═══════════════════════════════════════════════════════════════════════════════
# DRIVE CARD
# ═══════════════════════════════════════════════════════════════════════════════
class DriveCard(QWidget):
    def __init__(self, d: dict):
        super().__init__(); self.d = d; self._ui()

    def _ui(self):
        lay = QHBoxLayout(self); lay.setContentsMargins(14,10,14,10); lay.setSpacing(12)
        ico = QLabel("" if self.d["total"] > 200*1024**3 else "")
        ico.setStyleSheet("font-size:22px;"); ico.setFixedWidth(30)
        lay.addWidget(ico)
        info = QVBoxLayout(); info.setSpacing(2)
        ltr = self.d.get("letter","?")
        name = QLabel(f"{self.d['label']}   <span style='color:{C['muted']};font-size:11px;'>"
                      f"({ltr})  •  {self.d['fstype']}</span>")
        name.setTextFormat(Qt.RichText)
        name.setStyleSheet(f"font-size:13px;font-weight:bold;color:{C['txt']};")
        tot, used = self.d["total"]/1024**3, self.d["used"]/1024**3
        size = QLabel(f"{used:.1f} GB used of {tot:.1f} GB  ({self.d['percent']}%)")
        size.setStyleSheet(f"font-size:11px;color:{C['muted']};")
        info.addWidget(name); info.addWidget(size)
        lay.addLayout(info); lay.addStretch()
        if self.d["locked"]:
            txt, css = "  ENCRYPTED", f"background:#3d1a1a;color:#f85149;border:1px solid {C['red']};"
        elif self.d["protected"]:
            txt, css = "  UNLOCKED", f"background:#1a3d2a;color:#3fb950;border:1px solid {C['green']};"
        else:
            txt, css = "  UNPROTECTED", f"background:#2d1e00;color:#d29922;border:1px solid {C['amber']};"
        st = QLabel(txt)
        st.setStyleSheet(css + "border-radius:10px;padding:3px 12px;font-size:11px;font-weight:bold;")
        lay.addWidget(st)


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN WINDOW
# ═══════════════════════════════════════════════════════════════════════════════
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.drives: List[dict] = []
        self.current: Optional[dict] = None
        self.prev_unlocked: Dict[str, dict] = {}
        self.settings = QSettings("DriveGuard", "DriveGuard")
        self.tray: Optional[QSystemTrayIcon] = None
        self.worker = CryptoWorker()
        self.worker.progress.connect(self._on_progress)
        self.worker.job_done.connect(self._on_job_done)
        self.worker.start()
        self._build(); self._theme(); self._setup_tray()
        self.refresh()
        # Fallback poll (slower) — instant detection comes from nativeEvent.
        self._timer = QTimer(self); self._timer.timeout.connect(self.refresh); self._timer.start(8000)

    # ── Native WM_DEVICECHANGE listener ───────────────────────────────────────
    def nativeEvent(self, eventType, message):
        if sys.platform == "win32" and eventType == b"windows_generic_MSG":
            try:
                msg = ctypes.wintypes.MSG.from_address(int(message))
                if msg.message == WM_DEVICECHANGE:
                    if msg.wParam in (DBT_DEVICEARRIVAL, DBT_DEVICEREMOVECOMPLETE,
                                      DBT_DEVNODES_CHANGED, DBT_DEVICEREMOVEPENDING):
                        # Tiny delay so the volume mount/unmount is fully settled
                        QTimer.singleShot(150, self.refresh)
            except Exception:
                pass
        return super().nativeEvent(eventType, message)

    # ── UI ────────────────────────────────────────────────────────────────────
    def _build(self):
        self.setWindowTitle(f"{APP_NAME} v{APP_VERSION}  —  AES-256 USB Drive Encryption")
        self.setMinimumSize(960, 640); self.resize(1080, 720)
        cw = QWidget(); self.setCentralWidget(cw)
        root = QHBoxLayout(cw); root.setSpacing(0); root.setContentsMargins(0,0,0,0)

        # Sidebar
        side = QFrame(); side.setObjectName("side"); side.setFixedWidth(230)
        sl = QVBoxLayout(side); sl.setSpacing(0); sl.setContentsMargins(0,0,0,0)

        logo_f = QFrame(); logo_f.setObjectName("logoF")
        ll = QVBoxLayout(logo_f); ll.setContentsMargins(18,22,18,22)
        t1 = QLabel("  DriveGuard"); t1.setStyleSheet(f"font-size:18px;font-weight:bold;color:{C['txt']};")
        t2 = QLabel(f"v{APP_VERSION} · AES-256"); t2.setStyleSheet(f"font-size:11px;color:{C['muted']};")
        ll.addWidget(t1); ll.addWidget(t2); sl.addWidget(logo_f)

        sf = QFrame(); sf.setObjectName("statsF")
        stl = QVBoxLayout(sf); stl.setContentsMargins(18,14,18,14); stl.setSpacing(6)
        stl.addWidget(self._hdr("DRIVE STATUS"))
        self.s_total = QLabel(); self.s_enc = QLabel()
        self.s_unlock = QLabel(); self.s_unp = QLabel()
        for lbl in (self.s_total,self.s_enc,self.s_unlock,self.s_unp):
            lbl.setStyleSheet(f"font-size:12px;color:{C['muted']};"); stl.addWidget(lbl)
        sl.addWidget(sf)

        af = QFrame(); af.setObjectName("algoF")
        al = QVBoxLayout(af); al.setContentsMargins(18,14,18,14); al.setSpacing(4)
        al.addWidget(self._hdr("ENCRYPTION"))
        for line in ("Algorithm: AES-256-GCM","KDF: PBKDF2-HMAC-SHA256",
                     f"Iterations: {KDF_ITERS:,}","Streaming chunked I/O","Auth Tag: 128-bit"):
            lb = QLabel(line); lb.setStyleSheet(f"font-size:11px;color:{C['muted']};")
            lb.setWordWrap(True); al.addWidget(lb)
        sl.addWidget(af)

        setF = QFrame(); setF.setObjectName("setF")
        setL = QVBoxLayout(setF); setL.setContentsMargins(18,14,18,14); setL.setSpacing(6)
        setL.addWidget(self._hdr("SETTINGS"))
        self.cb_eject = QCheckBox("Auto-lock on eject")
        self.cb_eject.setChecked(self.settings.value("auto_lock_eject", False, bool))
        self.cb_eject.toggled.connect(lambda v: self.settings.setValue("auto_lock_eject", v))
        self.cb_toast = QCheckBox("Show notifications")
        self.cb_toast.setChecked(self.settings.value("toast", True, bool))
        self.cb_toast.toggled.connect(lambda v: self.settings.setValue("toast", v))
        self.cb_obf   = QCheckBox("Obfuscate filenames")
        self.cb_obf.setChecked(self.settings.value("obfuscate", True, bool))
        self.cb_obf.toggled.connect(lambda v: self.settings.setValue("obfuscate", v))
        self.cb_wipe  = QCheckBox("Secure-wipe originals")
        self.cb_wipe.setChecked(self.settings.value("wipe", False, bool))
        self.cb_wipe.toggled.connect(lambda v: self.settings.setValue("wipe", v))
        for c in (self.cb_eject, self.cb_toast, self.cb_obf, self.cb_wipe):
            c.setStyleSheet(f"color:{C['muted']};font-size:11px;")
            setL.addWidget(c)
        sl.addWidget(setF)

        sl.addStretch()
        rb = QPushButton("   Refresh Drives"); rb.setObjectName("sideBtn")
        rb.clicked.connect(self.refresh); sl.addWidget(rb)
        root.addWidget(side)

        # Main
        main = QFrame(); main.setObjectName("main")
        ml = QVBoxLayout(main); ml.setSpacing(0); ml.setContentsMargins(0,0,0,0)

        hdr = QFrame(); hdr.setObjectName("hdr"); hdr.setFixedHeight(56)
        hl = QHBoxLayout(hdr); hl.setContentsMargins(20,0,20,0)
        ht = QLabel("Connected Storage Devices")
        ht.setStyleSheet(f"font-size:15px;font-weight:bold;color:{C['txt']};")
        hl.addWidget(ht); hl.addStretch()
        self.lock_all_btn = QPushButton("  Lock All"); self.lock_all_btn.setObjectName("dangerBtn")
        self.lock_all_btn.clicked.connect(self.lock_all); hl.addWidget(self.lock_all_btn)
        ml.addWidget(hdr)

        self.lst = QListWidget(); self.lst.setObjectName("lst")
        self.lst.setSelectionMode(QAbstractItemView.SingleSelection)
        self.lst.currentRowChanged.connect(self._sel)
        ml.addWidget(self.lst)

        self.pframe = QFrame(); self.pframe.setObjectName("pframe"); self.pframe.setFixedHeight(66)
        pl = QVBoxLayout(self.pframe); pl.setContentsMargins(20,8,20,8); pl.setSpacing(4)
        self.plbl = QLabel("Working…"); self.plbl.setStyleSheet(f"color:{C['muted']};font-size:11px;")
        self.pbar = QProgressBar(); self.pbar.setObjectName("pbar"); self.pbar.setFixedHeight(12)
        pl.addWidget(self.plbl); pl.addWidget(self.pbar)
        self.pframe.hide(); ml.addWidget(self.pframe)

        act = QFrame(); act.setObjectName("actF"); act.setFixedHeight(74)
        al2 = QHBoxLayout(act); al2.setContentsMargins(20,12,20,12); al2.setSpacing(8)
        self.btn_lock   = QPushButton("  Lock Drive");      self.btn_lock.setObjectName("lockBtn")
        self.btn_unlock = QPushButton("  Unlock Drive");    self.btn_unlock.setObjectName("unlockBtn")
        self.btn_recov  = QPushButton("  Recovery");        self.btn_recov.setObjectName("recBtn")
        self.btn_change = QPushButton("  Change Password"); self.btn_change.setObjectName("neutBtn")
        self.btn_repair = QPushButton("  Repair"); self.btn_repair.setObjectName("neutBtn")
        self.btn_ref    = QPushButton("  Refresh"); self.btn_ref.setObjectName("neutBtn")
        for b in (self.btn_lock,self.btn_unlock,self.btn_recov,self.btn_change,self.btn_repair): b.setEnabled(False)
        self.btn_lock.clicked.connect(self.lock_drive)
        self.btn_unlock.clicked.connect(self.unlock_drive)
        self.btn_recov.clicked.connect(self.recovery_unlock)
        self.btn_change.clicked.connect(self.change_password)
        self.btn_repair.clicked.connect(self.repair_drive)
        self.btn_ref.clicked.connect(self.refresh)
        al2.addWidget(self.btn_lock,2); al2.addWidget(self.btn_unlock,2)
        al2.addWidget(self.btn_recov,2); al2.addWidget(self.btn_change,2)
        al2.addWidget(self.btn_repair,2); al2.addWidget(self.btn_ref,1)
        ml.addWidget(act)
        root.addWidget(main)

        sb = self.statusBar()
        sb.showMessage(f"  {APP_NAME} v{APP_VERSION}  —  AES-256-GCM Engine Ready · WM_DEVICECHANGE active")
        sb.setStyleSheet(f"background:{C['blue']};color:white;font-size:11px;")

    def _theme(self):
        self.setStyleSheet(f"""
            QMainWindow {{ background:{C['bg0']}; }}
            QFrame#side, QFrame#logoF, QFrame#statsF, QFrame#algoF, QFrame#setF
                {{ background:{C['bg1']}; border-right:1px solid {C['bd']}; }}
            QFrame#logoF, QFrame#statsF, QFrame#algoF, QFrame#setF
                {{ border-bottom:1px solid {C['bd']}; }}
            QPushButton#sideBtn {{
                background:transparent; color:{C['muted']}; border:none;
                border-top:1px solid {C['bd']}; padding:12px 18px;
                text-align:left; font-size:12px;
            }}
            QPushButton#sideBtn:hover {{ background:{C['bg2']}; color:{C['txt']}; }}
            QFrame#main {{ background:{C['bg0']}; }}
            QFrame#hdr  {{ background:{C['bg0']}; border-bottom:1px solid {C['bd']}; }}
            QFrame#actF {{ background:{C['bg1']}; border-top:1px solid {C['bd']}; }}
            QFrame#pframe {{ background:{C['bg1']}; border-top:1px solid {C['bd']}; }}
            QListWidget#lst {{ background:{C['bg0']}; border:none; outline:none; }}
            QListWidget#lst::item {{ background:{C['bg0']}; border-bottom:1px solid {C['bd']}; padding:0; }}
            QListWidget#lst::item:selected {{ background:#1c2333; border-left:3px solid {C['blue']}; }}
            QListWidget#lst::item:hover {{ background:#1c2333; }}
            QPushButton#lockBtn {{ background:#3d1a1a; color:#f85149; border:1px solid {C['red']};
                border-radius:8px; padding:10px; font-size:12px; font-weight:bold; }}
            QPushButton#lockBtn:hover:enabled {{ background:{C['red']}; color:white; }}
            QPushButton#unlockBtn {{ background:#1a3d2a; color:#3fb950; border:1px solid {C['green']};
                border-radius:8px; padding:10px; font-size:12px; font-weight:bold; }}
            QPushButton#unlockBtn:hover:enabled {{ background:{C['green']}; color:white; }}
            QPushButton#recBtn {{ background:#2d1e00; color:#d29922; border:1px solid {C['amber']};
                border-radius:8px; padding:10px; font-size:12px; font-weight:bold; }}
            QPushButton#recBtn:hover:enabled {{ background:{C['amber']}; color:white; }}
            QPushButton#neutBtn {{ background:{C['bg2']}; color:{C['muted']};
                border:1px solid {C['bd']}; border-radius:8px; padding:10px; font-size:12px; }}
            QPushButton#neutBtn:hover:enabled {{ border-color:{C['muted']}; color:{C['txt']}; }}
            QPushButton:disabled {{ background:{C['bg2']}; color:#484f58; border-color:{C['bd']}; }}
            QPushButton#dangerBtn {{ background:#3d1a1a; color:#f85149; border:1px solid {C['red']};
                border-radius:6px; padding:7px 14px; font-size:12px; font-weight:bold; }}
            QPushButton#dangerBtn:hover {{ background:{C['red']}; color:white; }}
            QProgressBar#pbar {{ background:{C['bg2']}; border:1px solid {C['bd']}; border-radius:6px; }}
            QProgressBar#pbar::chunk {{
                background:qlineargradient(x1:0,y1:0,x2:1,y2:0,stop:0 {C['blue']},stop:1 #58a6ff);
                border-radius:5px; }}
            QLabel {{ color:{C['txt']}; }}
            QMessageBox {{ background:{C['bg1']}; color:{C['txt']}; }}
            QMessageBox QPushButton {{
                background: {C['bg2']}; color: {C['txt']};
                border: 1px solid {C['bd']}; border-radius: 6px;
                padding: 6px 18px; min-width: 80px; font-weight: bold;
            }}
            QMessageBox QPushButton:hover {{ background: {C['bd']}; border-color: {C['muted']}; }}
        """)

    def _setup_tray(self):
        if not QSystemTrayIcon.isSystemTrayAvailable(): return
        pm = QPixmap(32,32); pm.fill(Qt.transparent)
        p = QPainter(pm); p.setRenderHint(QPainter.Antialiasing)
        p.setBrush(QBrush(QColor(C["blue"]))); p.setPen(Qt.NoPen)
        p.drawRoundedRect(2,2,28,28,6,6); p.setPen(QColor("#ffffff"))
        f = QFont("Segoe UI",16); f.setBold(True); p.setFont(f)
        p.drawText(pm.rect(), Qt.AlignCenter, ""); p.end()
        self.tray = QSystemTrayIcon(QIcon(pm), self)
        self.tray.setToolTip(f"{APP_NAME} v{APP_VERSION}")
        m = QMenu()
        a_show = QAction("Show DriveGuard", self); a_show.triggered.connect(self.showNormal)
        a_lock = QAction("Lock All Drives", self); a_lock.triggered.connect(self.lock_all)
        a_quit = QAction("Quit", self); a_quit.triggered.connect(QApplication.quit)
        m.addAction(a_show); m.addAction(a_lock); m.addSeparator(); m.addAction(a_quit)
        self.tray.setContextMenu(m); self.tray.show()

    def _hdr(self, text):
        lb = QLabel(text)
        lb.setStyleSheet(f"font-size:10px;color:{C['muted']};font-weight:bold;letter-spacing:1px;")
        return lb

    def _toast(self, title, message, level="info"):
        if not self.tray or not self.settings.value("toast", True, bool): return
        icon = {"info":QSystemTrayIcon.Information,"warn":QSystemTrayIcon.Warning,
                "err":QSystemTrayIcon.Critical}.get(level, QSystemTrayIcon.Information)
        self.tray.showMessage(title, message, icon, 4000)

    # ── Refresh & auto-lock-on-eject ──────────────────────────────────────────
    def refresh(self):
        new_drives = Scanner.get_drives()
        new_mps = {d["mountpoint"] for d in new_drives}

        # Auto-lock-on-eject: detect drives that disappeared since last refresh
        if self.settings.value("auto_lock_eject", False, bool):
            for mp, prev in self.prev_unlocked.items():
                if mp not in new_mps:
                    self._toast(" Drive ejected while unlocked!",
                                f"{prev['label']} ({mp}) was UNLOCKED when removed. "
                                f"Re-insert and lock immediately!", "warn")
        # Track currently unlocked (protected, not locked) for next refresh
        self.prev_unlocked = {d["mountpoint"]: d for d in new_drives
                              if d["protected"] and not d["locked"]}

        self.drives = new_drives
        self.lst.clear()
        for d in self.drives:
            item = QListWidgetItem(self.lst); card = DriveCard(d)
            item.setSizeHint(QSize(0, 72))
            self.lst.addItem(item); self.lst.setItemWidget(item, card)
        if not self.drives:
            self.lst.addItem("     No removable drives detected — plug in a USB drive")

        locked = sum(1 for d in self.drives if d["locked"])
        prot   = sum(1 for d in self.drives if d["protected"] and not d["locked"])
        unp    = sum(1 for d in self.drives if not d["protected"])
        self.s_total.setText(f"Total drives:  {len(self.drives)}")
        self.s_enc.setText(  f"Encrypted:  {locked}")
        self.s_unlock.setText(f"Unlocked:  {prot}")
        self.s_unp.setText(  f"Unprotected:  {unp}")
        self._sel(self.lst.currentRow())

    def _sel(self, row: int):
        self.current = self.drives[row] if 0 <= row < len(self.drives) else None
        d, ok = self.current, self.current is not None
        self.btn_lock.setEnabled(ok and not (d and d["locked"]))
        self.btn_unlock.setEnabled(ok and bool(d and d["locked"]))
        self.btn_recov.setEnabled(ok and bool(d and d["locked"]))
        self.btn_change.setEnabled(ok and bool(d and d["protected"] and not d["locked"]))
        self.btn_repair.setEnabled(ok)
        if ok and d and not d["protected"]:
            self.btn_lock.setText("  Set Password & Encrypt")
        else:
            self.btn_lock.setText("  Lock Drive")

    def _opts(self) -> dict:
        return {"obfuscate": self.settings.value("obfuscate", True, bool),
                "wipe":      self.settings.value("wipe", False, bool)}

    # ── Lock ──────────────────────────────────────────────────────────────────
    def lock_drive(self):
        d = self.current
        if not d: return
        mp = d["mountpoint"]; lk = Path(mp) / LOCK_FILENAME
        if d["protected"] and lk.exists():
            try: meta = json.loads(lk.read_text(encoding="utf-8"))
            except Exception:
                QMessageBox.critical(self,"Error","Lock file is corrupt."); return
            dlg = PwdDialog(self,"enter",f"{d['label']} ({d['letter']})")
            if dlg.exec_() != QDialog.Accepted or not dlg.password: return
            mk = Engine.unlock_with_password(meta, dlg.password)
            if mk is None:
                QMessageBox.critical(self,"Wrong Password","  Incorrect password."); return
            self._enqueue(mp, mk, "lock", d['label'])
            return

        files = Scanner.plaintext_files(mp)
        if not files:
            QMessageBox.information(self,"Nothing to Encrypt","No files found."); return
        opts = self._opts()
        extras = []
        if opts["obfuscate"]: extras.append("• Filenames will be obfuscated")
        if opts["wipe"]:      extras.append("• Originals will be SECURELY WIPED before delete")
        extra_txt = ("\\n\\n" + "\\n".join(extras)) if extras else ""
        ans = QMessageBox.warning(self,"Confirm Encryption",
            f"  Encrypt all files on:\\n\\n   {d['label']}  ({d['letter']})\\n\\n"
            f"   {len(files)} file(s) → AES-256-GCM"
            f"{extra_txt}\\n\\n"
            f"You'll get a recovery code in case you forget the password.\\nContinue?",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if ans != QMessageBox.Yes: return

        dlg = PwdDialog(self,"set",f"{d['label']} ({d['letter']})")
        if dlg.exec_() != QDialog.Accepted or not dlg.password: return
        meta, recovery_code = Engine.make_metadata(dlg.password)
        write_lockfile(mp, meta)
        RecoveryShowDialog(self, recovery_code, d['label']).exec_()
        mk = Engine.unlock_with_password(meta, dlg.password)
        if mk is None:
            QMessageBox.critical(self,"Internal Error","Key derivation failed."); return
        self._enqueue(mp, mk, "lock", d['label'])

    # ── Unlock ────────────────────────────────────────────────────────────────
    def unlock_drive(self):
        d = self.current
        if not d: return
        meta = self._load_meta(d["mountpoint"])
        if meta is None: return
        dlg = PwdDialog(self,"enter",f"{d['label']} ({d['letter']})")
        if dlg.exec_() != QDialog.Accepted or not dlg.password: return
        mk = Engine.unlock_with_password(meta, dlg.password)
        if mk is None:
            QMessageBox.critical(self,"Wrong Password",
                "  Incorrect password.\\n\\nForgot it? Use  Recovery."); return
        self._enqueue(d["mountpoint"], mk, "unlock", d['label'])

    def recovery_unlock(self):
        d = self.current
        if not d: return
        meta = self._load_meta(d["mountpoint"])
        if meta is None: return
        if "wrapped_rec" not in meta:
            QMessageBox.warning(self,"No Recovery","Drive has no recovery code."); return
        dlg = RecoveryUseDialog(self, f"{d['label']} ({d['letter']})")
        if dlg.exec_() != QDialog.Accepted or not dlg.code: return
        mk = Engine.unlock_with_recovery(meta, dlg.code)
        if mk is None:
            QMessageBox.critical(self,"Invalid Code","  Recovery code is incorrect."); return
        ans = QMessageBox.question(self,"Set New Password?",
            "Drive will be unlocked.\\nWould you like to set a NEW password now?",
            QMessageBox.Yes | QMessageBox.No)
        if ans == QMessageBox.Yes:
            pw = PwdDialog(self,"set",f"{d['label']} ({d['letter']})")
            if pw.exec_() == QDialog.Accepted and pw.password:
                meta = Engine.rewrap_password(meta, mk, pw.password)
                meta, new_code = Engine.rewrap_recovery(meta, mk)
                write_lockfile(d["mountpoint"], meta)
                RecoveryShowDialog(self, new_code, d['label']).exec_()
        self._enqueue(d["mountpoint"], mk, "unlock", d['label'])

    def change_password(self):
        d = self.current
        if not d: return
        meta = self._load_meta(d["mountpoint"])
        if meta is None: return
        dlg = PwdDialog(self,"change",f"{d['label']} ({d['letter']})")
        if dlg.exec_() != QDialog.Accepted: return
        mk = Engine.unlock_with_password(meta, dlg.old_password or "")
        if mk is None:
            QMessageBox.critical(self,"Wrong Password","  Current password incorrect."); return
        meta = Engine.rewrap_password(meta, mk, dlg.password or "")
        write_lockfile(d["mountpoint"], meta)
        ans = QMessageBox.question(self,"New Recovery Code?",
            "Generate a new recovery code as well?\\n(The old code will stop working.)",
            QMessageBox.Yes | QMessageBox.No)
        if ans == QMessageBox.Yes:
            meta, code = Engine.rewrap_recovery(meta, mk)
            write_lockfile(d["mountpoint"], meta)
            RecoveryShowDialog(self, code, d['label']).exec_()
        QMessageBox.information(self,"Success","  Password changed.")
        self._toast("Password Changed", f"{d['label']}: password updated.")

    # ── Repair: scan for orphaned .part files from interrupted lock runs ──────
    def repair_drive(self):
        d = self.current
        if not d: return
        root = Path(d["mountpoint"])
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            parts = find_orphan_parts(root)
            survivors = find_orphan_originals(root)
        finally:
            QApplication.restoreOverrideCursor()

        lines = []
        if parts:
            total_mb = sum(p.stat().st_size for p in parts) / (1024*1024)
            lines.append(f"Found {len(parts)} orphan .part file(s) — {total_mb:.1f} MB total.")
            lines.append("These are incomplete encryptions from an interrupted lock run.")
            lines.append("They cannot be decrypted and are safe to delete.\\n")
            for p in parts[:8]:
                lines.append(f"  - {p.relative_to(root)}  ({p.stat().st_size//1024} KB)")
            if len(parts) > 8:
                lines.append(f"  ... and {len(parts)-8} more")
        if survivors:
            lines.append("")
            lines.append(f"Found {len(survivors)} original file(s) that survived alongside their .dge copy.")
            lines.append("Your originals are intact — no action needed (Unlock will skip these safely).")
        if not parts and not survivors:
            QMessageBox.information(self,"Repair","  No orphan files found. Drive is clean.")
            return

        msg = "\\n".join(lines)
        if parts:
            ans = QMessageBox.question(self,"Repair Drive",
                msg + "\\n\\nDelete the orphan .part files now?",
                QMessageBox.Yes | QMessageBox.No)
            if ans == QMessageBox.Yes:
                deleted = 0
                for p in parts:
                    try: p.unlink(); deleted += 1
                    except OSError: pass
                QMessageBox.information(self,"Repair Complete",
                    f"  Deleted {deleted} of {len(parts)} orphan file(s).")
                self._toast("Repair Complete", f"{d['label']}: removed {deleted} orphan file(s).")
                self.refresh()
        else:
            QMessageBox.information(self,"Repair", msg)

    def _load_meta(self, mp: str) -> Optional[dict]:
        lk = Path(mp) / LOCK_FILENAME
        if not lk.exists():
            QMessageBox.warning(self,"No Lock File","Drive has no DriveGuard lock file."); return None
        try:
            return json.loads(lk.read_text(encoding="utf-8"))
        except Exception:
            QMessageBox.critical(self,"Error","Lock file is corrupt."); return None

    def lock_all(self):
        cands = [d for d in self.drives if d["protected"] and not d["locked"]]
        if not cands:
            QMessageBox.information(self,"Nothing to Lock","No unlocked protected drives."); return
        ans = QMessageBox.question(self,"Lock All",
            f"Lock {len(cands)} drive(s)? You'll be prompted for each password.",
            QMessageBox.Yes | QMessageBox.No)
        if ans != QMessageBox.Yes: return
        for drv in cands:
            meta = self._load_meta(drv["mountpoint"])
            if meta is None: continue
            dlg = PwdDialog(self,"enter",f"{drv['label']} ({drv['letter']})")
            if dlg.exec_() != QDialog.Accepted or not dlg.password: continue
            mk = Engine.unlock_with_password(meta, dlg.password)
            if mk is None:
                QMessageBox.warning(self,"Skipped",f"Wrong password for {drv['label']}."); continue
            self._enqueue(drv["mountpoint"], mk, "lock", drv['label'])

    def _enqueue(self, mp: str, key: bytes, mode: str, label: str):
        self.pframe.show(); self.pbar.setValue(0)
        self.plbl.setText(f"Queued {mode}: {label} — do NOT remove drive!")
        self.statusBar().showMessage(f"  Queued {mode} → {mp}")
        self.worker.enqueue(mp, key, mode, self._opts())

    def _on_progress(self, pct, txt):
        self.pbar.setValue(pct); self.plbl.setText(txt)

    def _on_job_done(self, ok, msg, mp):
        self.pframe.hide(); self.pbar.setValue(0)
        self._toast("DriveGuard" if ok else "DriveGuard Error",
                    f"{mp}: {msg}", "info" if ok else "err")
        self.statusBar().showMessage(f"  {msg}")
        self.refresh()

    def closeEvent(self, e):
        self.worker.stop(); self.worker.wait(2000); super().closeEvent(e)


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════
def main():
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME); app.setApplicationVersion(APP_VERSION)
    app.setFont(QFont("Segoe UI", 10))
    pal = QPalette()
    pal.setColor(QPalette.Window,          QColor("#0d1117"))
    pal.setColor(QPalette.WindowText,      QColor("#f0f6fc"))
    pal.setColor(QPalette.Base,            QColor("#161b22"))
    pal.setColor(QPalette.AlternateBase,   QColor("#21262d"))
    pal.setColor(QPalette.Text,            QColor("#f0f6fc"))
    pal.setColor(QPalette.Button,          QColor("#21262d"))
    pal.setColor(QPalette.ButtonText,      QColor("#f0f6fc"))
    pal.setColor(QPalette.Highlight,       QColor("#1f6feb"))
    pal.setColor(QPalette.HighlightedText, QColor("#ffffff"))
    app.setPalette(pal)
    w = MainWindow(); w.show()
    sys.exit(app.exec_())

if __name__ == "__main__":
    main()
`;

export const REQUIREMENTS_TXT = `# DriveGuard v1.2 Requirements
# Install with: pip install -r requirements.txt

PyQt5>=5.15.0
cryptography>=41.0.0
psutil>=5.9.0
`;

export const INSTALL_BAT = `@echo off
title DriveGuard — Installer
echo.
echo  ====================================================
echo    DriveGuard v1.2  —  USB Drive Encryption Tool
echo  ====================================================
echo.
echo  Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found! Download from https://python.org
    pause & exit /b 1
)
echo  Python found.
echo.
echo  Installing required packages...
pip install PyQt5 cryptography psutil
echo.
echo  ====================================================
echo    Installation complete! Run driveguard.py
echo  ====================================================
echo.
pause
`;

export const RUN_BAT = `@echo off
title DriveGuard
python driveguard.py
if errorlevel 1 (
    echo.
    echo ERROR: Run install.bat first!
    pause
)
`;

export const SETUP_PY = `"""
DriveGuard — Build standalone .exe with PyInstaller
Run:  python setup.py
Output:  dist/DriveGuard.exe
"""
import subprocess, sys

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--onefile", "--windowed",
    "--name", "DriveGuard",
    "--icon", "NONE",
    "driveguard.py"
]
print("Building DriveGuard.exe ...")
subprocess.run(cmd, check=True)
print("\\nDone! Find DriveGuard.exe in the 'dist/' folder.")
`;

export const README_MD = `#  DriveGuard

**Standalone USB / external-drive encryption for Windows.**
AES-256-GCM · PBKDF2-HMAC-SHA256 · Master-key model with recovery codes.
No BitLocker. No VeraCrypt. Pure Python + PyQt5.

---

## Table of Contents

1. [What it does](#what-it-does)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Quick start](#quick-start)
5. [Building a standalone .exe](#building-a-standalone-exe)
6. [How the encryption works](#how-the-encryption-works)
7. [On-disk file format](#on-disk-file-format)
8. [\\.drivelock metadata](#drivelock-metadata)
9. [Recovery codes](#recovery-codes)
10. [Settings](#settings)
11. [Project layout](#project-layout)
12. [Threat model & limitations](#threat-model--limitations)
13. [FAQ](#faq)
14. [License](#license)

---

## What it does

DriveGuard encrypts every file on a removable drive (USB stick, external SSD,
SD card, etc.) with **AES-256-GCM** in 1 MiB streaming chunks. Each drive gets:

- A random 256-bit **Master Key** that actually encrypts files.
- A user **password** that wraps the Master Key (PBKDF2 → KEK → AES-GCM wrap).
- A 24-character **recovery code** that wraps the same Master Key under a
  second, independent KEK. Either credential can unlock the drive.

Features:

-  Real, file-level encryption — every file is rewritten as \`<name>.dge\`.
-  **Recovery codes** so a forgotten password is not the end of the world.
-  **Streaming, chunked I/O** — multi-GB files run in constant memory.
-  **Filename obfuscation** (optional) — on-disk names become random hex; the
  real filename lives encrypted inside the file's header.
-  **Secure-wipe of originals** (optional) — single-pass random overwrite +
  fsync before unlink. Best-effort on flash media (see Limitations).
-  **Native \`WM_DEVICECHANGE\` listener** — drives are detected in ~150 ms
  on plug/eject; an 8-second poll runs as a safety net.
-  Tray icon + Windows toast notifications for every operation.
-  Dark, GitHub-inspired PyQt5 UI with live password-strength meter.

---

## Requirements

- **Windows 10 / 11** (drive enumeration uses Win32 APIs via \`ctypes\`).
  The code runs on Linux/macOS but device detection is Windows-specific.
- **Python 3.8+** (3.10+ recommended).
- Three packages (auto-installed by \`install.bat\`):
  - \`PyQt5 >= 5.15\`
  - \`cryptography >= 41\`
  - \`psutil >= 5.9\`

Run as **Administrator** if you need access to all removable drives.

---

## Installation

### Option A — Batch script

\`\`\`bat
:: Double-click in Explorer or run from a terminal:
install.bat
\`\`\`

### Option B — Manual

\`\`\`bash
pip install -r requirements.txt
\`\`\`

---

## Quick start

\`\`\`bat
:: Double-click run.bat, or:
python driveguard.py
\`\`\`

1. Plug in a USB drive. DriveGuard detects it instantly.
2. Select the drive in the list.
3. Click **Set Password & Encrypt** (new drive) or ** Lock Drive** (re-lock).
4. Enter a strong password (live strength meter).
5. **Save the recovery code** that pops up — you only see it once.
   Use the **Copy** or **Save to File** button.
6. Encryption starts. Do not eject until the progress bar reads "Done!".

To unlock later: select the drive → ** Unlock Drive** → enter password.
Forgot it? ** Recovery** → paste the 24-char code.

---

## Building a standalone .exe

\`\`\`bash
pip install pyinstaller
python setup.py
\`\`\`

Produces \`dist/DriveGuard.exe\` — a single-file executable that runs on
Windows machines without Python installed.

---

## How the encryption works

\`\`\`
                          ┌──────────────────────────┐
        password ─PBKDF2─▶│  KEK_pwd  (256-bit)      │──AES-GCM wrap─┐
                          └──────────────────────────┘               │
                                                                     ▼
                                                          ┌────────────────────┐
                                                          │  Master Key (MK)   │ ◀── random 256-bit
                                                          └────────────────────┘
                                                                     ▲
                          ┌──────────────────────────┐               │
   recovery code ─PBKDF2─▶│  KEK_rec  (256-bit)      │──AES-GCM wrap─┘
                          └──────────────────────────┘
\`\`\`

- **PBKDF2-HMAC-SHA256**, 310,000 iterations (NIST 2023), independent 32-byte
  salts for password and recovery code.
- The Master Key is **never written to disk in plaintext**. \`.drivelock\` only
  contains the two AES-GCM-wrapped copies.
- Files are encrypted with the Master Key directly, in 1 MiB chunks, each
  chunk having its own 96-bit nonce and 128-bit authentication tag.
- The original filename is encrypted into each file's header (AAD = \`b"DG-NAME"\`),
  so filenames can be obfuscated without losing them.

---

## On-disk file format

Every encrypted file uses **wire format v3**:

\`\`\`
+--------------+-------------+-----------+-----------------+
|  MAGIC (7)   | VERSION (1) | FLAGS (1) | CHUNK_SIZE (4)  |
+--------------+-------------+-----------+-----------------+
|  NAME_NONCE (12) | NAME_LEN (2 LE) | NAME_CT + TAG       |   ← original filename
+--------------+-------------+-----------+-----------------+
|  DATA_NONCE (12) | CT chunk (≤1 MiB) + TAG (16)          |
|  DATA_NONCE (12) | CT chunk (≤1 MiB) + TAG (16)          |
|  ...                                                     |
+--------------+-------------+-----------+-----------------+
\`\`\`

| Field        | Size    | Notes                                                       |
|--------------|---------|-------------------------------------------------------------|
| \`MAGIC\`      | 7 bytes | \`b"DGUARD3"\` — quick identification                          |
| \`VERSION\`    | 1 byte  | \`3\`                                                          |
| \`FLAGS\`      | 1 byte  | bit 0 = filename obfuscated on disk                         |
| \`CHUNK_SIZE\` | 4 bytes | little-endian \`uint32\` — plaintext chunk size (1 MiB)        |
| \`NAME_*\`     | varies  | original filename encrypted with AAD \`b"DG-NAME"\`            |
| \`DATA_*\`     | varies  | repeated chunk records, AAD \`b"DG-DATA"\`                     |

On-disk filename:

- **Obfuscation off:** \`originalname.ext.dge\`
- **Obfuscation on:**  \`<32-hex random>.dge\`

In both cases, the real filename is restored on decrypt from the encrypted header.

---

## .drivelock metadata

A hidden JSON file written atomically (\`.tmp\` → \`fsync\` → \`os.replace\`) at the
root of the drive:

\`\`\`json
{
  "app": "DriveGuard",
  "version": "1.2.0",
  "format": 3,
  "algorithm": "AES-256-GCM",
  "kdf": "PBKDF2-HMAC-SHA256",
  "iterations": 310000,
  "chunk_size": 1048576,
  "salt_pwd":  "<base64 32-byte salt>",
  "salt_rec":  "<base64 32-byte salt>",
  "wrapped_pwd": { "nonce": "<b64>", "ct": "<b64 MK + 16-byte tag>" },
  "wrapped_rec": { "nonce": "<b64>", "ct": "<b64 MK + 16-byte tag>" }
}
\`\`\`

**No keys, no password, and no verifier hashes are stored** — only AEAD-protected
key wraps. A wrong password is detected by the GCM tag failing on \`wrapped_pwd\`.

---

## Recovery codes

- 24 alphanumeric characters, base32, formatted as \`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX\`.
- Generated once when you first encrypt a drive and **shown only at that moment**.
- Can be copied to clipboard or saved to a \`.txt\` file via the recovery dialog.
- Re-rotated automatically when:
  - You use the recovery code to unlock and choose to set a new password.
  - You change the password and accept the "Generate a new recovery code?" prompt.

 **Treat the code like a password.** Anyone who has it can unlock the drive.

---

## Settings

Persisted via \`QSettings\` (\`HKCU\\Software\\DriveGuard\\DriveGuard\` on Windows).

| Setting                  | Default | What it does                                                       |
|--------------------------|---------|--------------------------------------------------------------------|
| Auto-lock on eject       | off     | Toast warning if a drive is removed while still unlocked.          |
| Show notifications       | on      | Enable / disable Windows balloon toasts.                           |
| Obfuscate filenames      | on      | Replace on-disk names with random 32-hex stems during encryption.  |
| Secure-wipe originals    | off     | Single-pass random overwrite + fsync before unlinking plaintext.   |

---

## Project layout

\`\`\`
.
├── driveguard.py         # The entire application (~900 LOC)
├── requirements.txt      # PyQt5, cryptography, psutil
├── install.bat           # One-click installer (Windows)
├── run.bat               # Launches python driveguard.py
├── setup.py              # PyInstaller build script → dist/DriveGuard.exe
└── README.md             # You are here
\`\`\`

There are no other files at runtime. The only state DriveGuard creates is:

- \`<drive>/.drivelock\`        — per-drive metadata (atomic, ~1 KB)
- \`<drive>/<file>.dge\`         — encrypted files
- \`HKCU\\Software\\DriveGuard\`  — user-settings registry key (Windows)

---

## Threat model & limitations

**DriveGuard protects against:**

- Loss/theft of the physical USB drive.
- Offline brute-force of the password (310,000 PBKDF2 rounds + 256-bit salt).
- Tampering with encrypted file content (AES-GCM tag verifies every chunk).
- File-name leakage *if* obfuscation is enabled.

**It does NOT protect against:**

- An attacker with code execution while the drive is **unlocked**. Plaintext
  files exist on the drive during that window.
- Forensic recovery of secure-wiped originals on flash media. Wear-leveling
  and the FTL can leave old copies in physically different cells. If you need
  guaranteed erasure, use full-drive secure-erase tools.
- Side channels — keyloggers, RAM scrapers, screen capture, etc. The Master
  Key is held in process memory while a drive is unlocked.
- Filesystem metadata (timestamps, free-space patterns, journal entries on
  NTFS). DriveGuard does not touch the filesystem layer.
- Drives where the \`.drivelock\` file is deleted by hand — without the metadata
  there is no way to unwrap the Master Key, so the drive becomes
  permanently inaccessible.

**Operational notes:**

- Always **safely eject** the drive after locking — interrupted writes are
  protected by atomic \`.tmp + os.replace\`, but in-flight chunks can still leave
  the file half-encrypted.
- If you **lose both the password AND the recovery code**, the data is gone.
  PBKDF2 + AES-256-GCM means there is no back door.
- Encrypting a 64 GB drive on USB 2.0 will be I/O-bound and slow; this is a
  property of the hardware, not the algorithm.

---

## FAQ

**Q: Can I read \`.dge\` files on Linux/macOS?**
The encryption engine itself is portable Python; only drive enumeration is
Windows-specific. You can run \`driveguard.py\` on other OSes and operate on a
mounted drive — the UI will simply not auto-detect drives the same way.

**Q: Is the recovery code stored anywhere?**
Only the **wrapped Master Key** (\`wrapped_rec\`) is stored, never the code itself.
The code lives in the user's head / printout / password manager.

**Q: Why AES-256-GCM and not XChaCha20-Poly1305?**
GCM is hardware-accelerated on virtually every modern CPU (AES-NI), and is
already in \`cryptography\`'s high-level AEAD interface. ChaCha would be a fine
swap if you target machines without AES-NI.

**Q: Can I script this?**
Currently no. The \`Engine\` class has no UI dependencies and could be imported
from another script if you want to build a CLI on top — patches welcome.

**Q: Does this work with BitLocker / VeraCrypt drives?**
DriveGuard operates at the **file** level, not the volume level. It runs on
top of any filesystem the OS exposes (FAT32, exFAT, NTFS, etc.) and is
independent of BitLocker / VeraCrypt — you can stack them if you want.

---

## License

This project is provided **as-is, without warranty of any kind**, for personal
and educational use. Review the source before trusting it with sensitive data.
`;

