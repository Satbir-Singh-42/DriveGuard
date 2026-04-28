# DriveGuard

A real Windows desktop tool for **AES-256-GCM** encryption of USB / external drives, delivered through a React landing page that bundles the Python source for download.

This repository contains two things:

1. **The DriveGuard Python application** (`src/app/constants/driveguard_py.ts`) — a single-file PyQt5 program packaged as constants and shipped to the user's browser as a downloadable `.py` plus install scripts.
2. **React landing page** (`src/app/App.tsx`) — overview, source viewer, and one-click installer download.

---

## DriveGuard application (v1.2)

A standalone Windows utility that locks the contents of a removable drive behind a password, with optional recovery codes for emergency access.

### Cryptography

| Property            | Value                                                  |
|---------------------|--------------------------------------------------------|
| Cipher              | AES-256-GCM (authenticated)                            |
| KDF                 | PBKDF2-HMAC-SHA256, 310 000 iterations (NIST 2023)     |
| Salt                | 32 bytes per drive, random                             |
| Nonce               | 12 bytes per chunk, random                             |
| Chunk size          | 1 MiB streaming                                        |
| Wire format         | `DGUARD3` v3 — magic, version, flags, encrypted name, chunked ciphertext |
| Master-key model    | Random 256-bit MK, double-wrapped (password + recovery code) using AES-GCM with AAD `DG-MK` |

### Features

- Real on-disk encryption — every file replaced with its `.dge` ciphertext
- Recovery codes (24-char base32, grouped) — unwraps the same master key as the password
- Optional filename obfuscation (FLAG_OBFUSCATE) — original name stored in encrypted header
- Optional secure wipe — single-pass random overwrite + fsync before unlink
- Atomic writes via `.tmp` + `os.replace` + `os.fsync`
- Native Windows `WM_DEVICECHANGE` listener (instant eject detection, no 4-second polling lag)
- Auto-lock on eject, system tray, persistent settings via `QSettings`

### Threat model

DriveGuard protects against an attacker who gains physical possession of an ejected drive. It does **not** protect against malware on the host machine while the drive is unlocked, nor against forensic recovery of file fragments that existed on the drive *before* it was first locked (use secure-wipe on the original or start with a freshly formatted drive).

### Running from source

```cmd
pip install PyQt5 cryptography psutil
python driveguard.py
```

Or use the bundled `install.bat` / `run.bat`. The download bundle also includes `setup.py` for PyInstaller packaging into a standalone `.exe`.

---

## Landing page (this repo)

Built with React + Vite + Tailwind v4 on top of Website. Entry point is `src/app/App.tsx`.

```
src/
  app/
    App.tsx                       # landing page
    constants/driveguard_py.ts    # DriveGuard source bundled as TS template literals
  styles/
    tailwind.css  theme.css
```

The user lands on the page, reads the overview, optionally browses the source, and downloads a 6-file zip-equivalent (`driveguard.py`, `requirements.txt`, `install.bat`, `run.bat`, `setup.py`, `README.md`).

### Development

```sh
pnpm install
```

---

## License

Educational / personal use. Cryptographic primitives are provided by the [`cryptography`](https://cryptography.io) library; review the source before trusting it with anything irreplaceable.
