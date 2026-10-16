# Windows: the Morfa .msi installer, x64 (docs/desktop.md §Builds). Run in PowerShell on a Windows machine with
# Rust (rustup, MSVC toolchain), Node 22 and the Visual Studio Build Tools ("Desktop development with C++"):
#
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build-windows.ps1
#
# Signing is the owner's (docs/desktop.md §Owner checklist). Without these the installer is unsigned (SmartScreen warns):
#   $env:MORFA_WINDOWS_CERT_THUMBPRINT   the code-signing certificate's thumbprint (in the user's certificate store)
#   $env:MORFA_WINDOWS_TIMESTAMP_URL     the CA's timestamp server, e.g. http://timestamp.digicert.com
#   $env:TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD)  the updater key: adds the signed .msi the updater downloads
# Output: desktop\src-tauri\target\release\bundle\msi\.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'build-windows: install Rust first (https://rustup.rs)' }
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'src-tauri\target' }
if (-not (Test-Path 'node_modules\@tauri-apps\cli')) { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed' } }
$config = @{ bundle = @{ windows = @{} } }
if ($env:MORFA_WINDOWS_CERT_THUMBPRINT) {
  $config.bundle.windows.certificateThumbprint = $env:MORFA_WINDOWS_CERT_THUMBPRINT
  $config.bundle.windows.timestampUrl = $(if ($env:MORFA_WINDOWS_TIMESTAMP_URL) { $env:MORFA_WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' })
} else {
  Write-Host 'build-windows: MORFA_WINDOWS_CERT_THUMBPRINT unset - the installer is unsigned'
}
if ($env:TAURI_SIGNING_PRIVATE_KEY) { $config.bundle.createUpdaterArtifacts = $true }
$json = $config | ConvertTo-Json -Depth 5 -Compress
npx tauri build --bundles msi --ci --config $json
if ($LASTEXITCODE) { throw 'tauri build failed' }
Get-ChildItem (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\msi\*.msi')
