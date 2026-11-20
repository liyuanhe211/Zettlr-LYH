#Requires -Version 5.1

<#
  start-sandbox.ps1 -- bring the development environment up to date and start
  the Zettlr-LYH sandbox.

  Zettlr_LYH.exe runs this script in the console window it creates (see
  StartSandbox() in Zettlr_LYH.cpp). It is the single place that knows how to
  take a machine from "nothing installed" to a running sandbox, so that a new
  computer needs nothing but a copy of the repository and this script.

  What it checks, in order, repairing whatever is missing or wrong:

    1. Node.js, at least major version $MinimumNodeMajor (electron 43 asks for
       >= 22.12.0). Installed from the official MSI on nodejs.org, whose
       SHA-256 is verified against the SHASUMS256.txt that sits next to it.
    2. corepack, which provides the yarn version pinned in package.json.
       Bundled with Node.js today; installed from npm should a future Node.js
       drop it.
    3. Git, which scripts/get-git-hash.js needs during the build. Installed
       from the official Git for Windows release on GitHub.
    4. node_modules, via `corepack yarn install`.
    5. The Electron binaries in node_modules/electron/dist. .yarnrc.yml sets
       enableScripts: false, so electron's own postinstall never runs and the
       binaries are not refreshed when the package version changes. A dist
       left over from another version makes electron.exe die with
       "Version mismatch between V8 binary and snapshot" before it executes
       anything -- which is what a half-copied repository looks like.

  Both installers need administrator rights, so they are started with
  Start-Process -Verb RunAs and Windows asks for consent. Nothing else here
  needs elevation.

  -CheckOnly reports the state of all five and starts nothing. It still
  repairs nothing, so it is safe to run while a sandbox is up.

  -RepairOnly repairs whatever is missing and exits without `yarn start`.
  Zettlr_LYH.exe uses it when port 3000 is taken, after making sure that no
  sandbox of this repository runs on the binaries it is about to replace.
#>

[CmdletBinding()]
param (
  # Report what is missing and exit, repairing and starting nothing.
  [switch] $CheckOnly,
  # Repair what is missing and exit without starting the sandbox.
  [switch] $RepairOnly
)

$ErrorActionPreference = 'Stop'

# Invoke-WebRequest spends most of its time painting the progress bar.
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# electron 43 declares "node": ">= 22.12.0" in its package.json. The newest
# LTS at or above this major version is what gets installed.
$MinimumNodeMajor = 22

$RepositoryDirectory = Split-Path -Parent $PSScriptRoot
$DownloadDirectory = Join-Path $env:TEMP 'Zettlr_LYH_setup'

# Stops corepack from asking "Do you want to download yarn@x.y.z?" and waiting
# for a key press that nobody is there to give.
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'

# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------

function Write-Step ([string] $Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok ([string] $Message) {
  Write-Host "    OK       $Message" -ForegroundColor DarkGray
}

function Write-Fixing ([string] $Message) {
  Write-Host "    FIXING   $Message" -ForegroundColor Yellow
}

function Write-Missing ([string] $Message) {
  Write-Host "    MISSING  $Message" -ForegroundColor Yellow
}

function Write-Warn ([string] $Message) {
  Write-Host "    WARNING  $Message" -ForegroundColor Magenta
}

function Write-Failure ([string] $Message) {
  Write-Host ''
  Write-Host "    FAILED   $Message" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# PowerShell 5.1 still negotiates TLS 1.0 by default on some builds, which
# nodejs.org and api.github.com refuse.
function Enable-ModernTls {
  $protocols = [Net.SecurityProtocolType]::Tls12
  # Tls13 only exists on newer .NET Framework versions.
  if ([enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
    $protocols = $protocols -bor [Net.SecurityProtocolType]::Tls13
  }
  [Net.ServicePointManager]::SecurityProtocol = $protocols
}

# An installer changes the persisted PATH, not the one this process inherited.
function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:PATH = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Find-Executable ([string] $Name) {
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
  if ($command) {
    return @($command)[0].Source
  }

  # Insurance for the case this script exists for: a program installed a
  # moment ago, where the PATH this process reads could still be the one it
  # started with. Probing the default install locations is cheap and makes the
  # first run on a new machine independent of how fast the environment
  # catches up.
  $fallbacks = @{
    'node'     = @("$env:ProgramFiles\nodejs\node.exe")
    'npm'      = @("$env:ProgramFiles\nodejs\npm.cmd")
    'corepack' = @("$env:ProgramFiles\nodejs\corepack.cmd", "$env:APPDATA\npm\corepack.cmd")
    'git'      = @("$env:ProgramFiles\Git\cmd\git.exe")
  }
  if ($fallbacks.ContainsKey($Name)) {
    foreach ($candidate in $fallbacks[$Name]) {
      if (Test-Path $candidate) {
        return $candidate
      }
    }
  }
  return $null
}

# "<what the program reports> at <where it was found>", for the OK lines.
function Get-ExecutableDescription ([string] $Name) {
  $path = Find-Executable $Name
  if (-not $path) {
    return 'not found'
  }
  $reported = & $path --version
  return "$((($reported -join ' ')).Trim()) at $path"
}

function Get-ProcessorArchitecture {
  # Under WOW64 the first variable reads x86; the second one holds the truth.
  $architecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $architecture) {
    $architecture = $env:PROCESSOR_ARCHITECTURE
  }
  if ($architecture -eq 'ARM64') {
    return 'arm64'
  }
  return 'x64'
}

function Save-Download ([string] $Url, [string] $Destination) {
  if (-not (Test-Path $DownloadDirectory)) {
    New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
  }
  Write-Host "             downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 600 `
    -Headers @{ 'User-Agent' = 'Zettlr-LYH-setup' }
  $megabytes = [math]::Round((Get-Item $Destination).Length / 1MB, 1)
  Write-Host "             saved $Destination ($megabytes MB)"
}

function Test-Sha256 ([string] $Path, [string] $Expected) {
  $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
  return $actual -ieq $Expected
}

# Runs an installer elevated and returns its exit code. Start-Process throws
# when the user dismisses the consent dialog, which is reported as such.
function Invoke-ElevatedInstaller ([string] $FilePath, [string[]] $ArgumentList, [string] $What) {
  Write-Host "             a Windows consent dialog will ask to install $What"
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Verb RunAs -Wait -PassThru
  } catch {
    throw "Installing $What needs administrator rights and the consent dialog was declined."
  }
  if ($process.ExitCode -ne 0) {
    throw "The $What installer exited with code $($process.ExitCode)."
  }
}

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------

function Get-InstalledNodeMajor {
  $node = Find-Executable 'node'
  if (-not $node) {
    return $null
  }
  $reported = & $node --version
  if ($LASTEXITCODE -ne 0 -or -not $reported) {
    return $null
  }
  $text = ([string]$reported).Trim().TrimStart('v')
  $parsed = 0
  if (-not [int]::TryParse(($text -split '\.')[0], [ref] $parsed)) {
    return $null
  }
  return $parsed
}

function Install-NodeJs {
  Enable-ModernTls
  $architecture = Get-ProcessorArchitecture

  # nodejs.org/dist/index.json is ordered newest first, so the first LTS entry
  # at or above the minimum major version is the newest one.
  Write-Host '             asking nodejs.org for the current LTS release'
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 120 `
    -Headers @{ 'User-Agent' = 'Zettlr-LYH-setup' }
  $release = $releases |
    Where-Object { $_.lts -and (([string]$_.version).TrimStart('v') -split '\.')[0] -as [int] -ge $MinimumNodeMajor } |
    Select-Object -First 1
  if (-not $release) {
    throw "nodejs.org lists no LTS release at or above Node $MinimumNodeMajor."
  }

  $version = [string] $release.version        # e.g. v24.21.0
  $fileName = "node-$version-$architecture.msi"
  $baseUrl = "https://nodejs.org/dist/$version"
  Write-Host "             chosen: Node.js $version ($($release.lts), $architecture)"

  # The checksum file lives next to the installer and is part of the release,
  # so a corrupted or truncated download is caught before it is executed.
  $sums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 120 `
    -Headers @{ 'User-Agent' = 'Zettlr-LYH-setup' }).Content
  $sumLine = ($sums -split "`n" | Where-Object { $_ -match "\s\*?$([regex]::Escape($fileName))\s*$" } | Select-Object -First 1)
  if (-not $sumLine) {
    throw "SHASUMS256.txt for Node.js $version does not list $fileName."
  }
  $expected = ($sumLine.Trim() -split '\s+')[0]

  $installer = Join-Path $DownloadDirectory $fileName
  Save-Download -Url "$baseUrl/$fileName" -Destination $installer
  if (-not (Test-Sha256 -Path $installer -Expected $expected)) {
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    throw "The downloaded $fileName does not match its published SHA-256. Nothing was installed."
  }
  Write-Host '             SHA-256 verified'

  Invoke-ElevatedInstaller -FilePath 'msiexec.exe' `
    -ArgumentList @('/i', "`"$installer`"", '/qn', '/norestart') `
    -What "Node.js $version"
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  Update-PathFromRegistry
}

# ---------------------------------------------------------------------------
# 2. corepack
# ---------------------------------------------------------------------------

function Install-Corepack {
  # corepack ships with Node.js today. Should a future release drop it, npm
  # can still supply it; the Windows MSI puts global packages under
  # %APPDATA%\npm, which needs no elevation.
  $npm = Find-Executable 'npm'
  if (-not $npm) {
    throw 'Neither corepack nor npm is available, so the pinned yarn version cannot be obtained.'
  }
  & $npm install --global corepack
  if ($LASTEXITCODE -ne 0) {
    throw 'npm install --global corepack failed.'
  }
  Update-PathFromRegistry
}

# ---------------------------------------------------------------------------
# 3. Git
# ---------------------------------------------------------------------------

function Install-Git {
  Enable-ModernTls
  $architecture = Get-ProcessorArchitecture
  # Git for Windows names its 64 bit build "64-bit", its ARM build "arm64".
  $pattern = if ($architecture -eq 'arm64') { '^Git-.*-arm64\.exe$' } else { '^Git-.*-64-bit\.exe$' }

  Write-Host '             asking github.com for the current Git for Windows release'
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' `
    -TimeoutSec 120 -Headers @{ 'User-Agent' = 'Zettlr-LYH-setup' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) {
    throw "The Git for Windows release $($release.tag_name) carries no asset matching $pattern."
  }
  Write-Host "             chosen: $($asset.name)"

  $installer = Join-Path $DownloadDirectory $asset.name
  Save-Download -Url $asset.browser_download_url -Destination $installer

  # Git for Windows publishes the checksums in the release notes rather than
  # in a file of their own, so this parse is the fragile part. A release whose
  # notes change shape must not stop a new machine from being set up, so a
  # missing checksum only warns: the download itself came over TLS from
  # github.com.
  $expected = $null
  $match = [regex]::Match($release.body, "$([regex]::Escape($asset.name))\s*\|\s*([0-9a-fA-F]{64})")
  if ($match.Success) {
    $expected = $match.Groups[1].Value
  }
  if ($expected) {
    if (-not (Test-Sha256 -Path $installer -Expected $expected)) {
      Remove-Item $installer -Force -ErrorAction SilentlyContinue
      throw "The downloaded $($asset.name) does not match the SHA-256 in its release notes. Nothing was installed."
    }
    Write-Host '             SHA-256 verified'
  } else {
    Write-Warn "The release notes of $($release.tag_name) carry no SHA-256 for $($asset.name); the download was not verified."
  }

  Invoke-ElevatedInstaller -FilePath $installer `
    -ArgumentList @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES') `
    -What "Git $($release.tag_name)"
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  Update-PathFromRegistry

  # The silent install accepts the installer's defaults, which put git on the
  # PATH. If a future default stops doing that, scripts/get-git-hash.js would
  # fail during every build, so fall back to pointing at it directly.
  if (-not (Find-Executable 'git')) {
    $fallback = Join-Path $env:ProgramFiles 'Git\cmd'
    if (Test-Path (Join-Path $fallback 'git.exe')) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      [Environment]::SetEnvironmentVariable('Path', "$userPath;$fallback", 'User')
      Update-PathFromRegistry
      Write-Host "             added $fallback to the user PATH"
    }
  }
}

# ---------------------------------------------------------------------------
# 4. node_modules
# ---------------------------------------------------------------------------

# yarn's node-modules linker writes this file once an install has completed,
# so it tells a finished install apart from an interrupted one.
function Test-DependenciesInstalled {
  return (Test-Path (Join-Path $RepositoryDirectory 'node_modules\.yarn-state.yml'))
}

function Install-Dependencies {
  & (Find-Executable 'corepack') yarn install
  if ($LASTEXITCODE -ne 0) {
    throw 'corepack yarn install failed.'
  }
}

# ---------------------------------------------------------------------------
# 5. The Electron binaries
# ---------------------------------------------------------------------------

function Get-ElectronVersions {
  $package = Join-Path $RepositoryDirectory 'node_modules\electron'
  $manifest = Join-Path $package 'package.json'
  if (-not (Test-Path $manifest)) {
    return $null
  }

  $wanted = (Get-Content $manifest -Raw | ConvertFrom-Json).version

  $installed = $null
  $versionFile = Join-Path $package 'dist\version'
  $executable = Join-Path $package 'dist\electron.exe'
  if ((Test-Path $versionFile) -and (Test-Path $executable)) {
    $installed = (Get-Content $versionFile -Raw).Trim().TrimStart('v')
  }

  return [pscustomobject] @{
    PackageDirectory = $package
    Wanted           = $wanted
    Installed        = $installed
  }
}

function Repair-ElectronBinary {
  $versions = Get-ElectronVersions
  $dist = Join-Path $versions.PackageDirectory 'dist'

  # Delete rather than extract over the top: a dist that holds files from two
  # versions at once is exactly the state that produces the V8 snapshot
  # mismatch, and only a clean directory rules it out.
  if (Test-Path $dist) {
    Remove-Item $dist -Recurse -Force
  }

  # electron's own postinstall, run by hand because .yarnrc.yml disables
  # install scripts. It downloads the build matching package.json and checks
  # it against the checksums.json shipped inside the package.
  & (Find-Executable 'node') (Join-Path $versions.PackageDirectory 'install.js')
  if ($LASTEXITCODE -ne 0) {
    throw 'node node_modules/electron/install.js failed.'
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Set-Location $RepositoryDirectory

Write-Host ''
Write-Host '  Zettlr-LYH development sandbox' -ForegroundColor White
Write-Host "  $RepositoryDirectory" -ForegroundColor DarkGray

$problems = New-Object System.Collections.Generic.List[string]

try {
  # --- Node.js ---------------------------------------------------------
  Write-Step 'Node.js'
  $major = Get-InstalledNodeMajor
  if ($null -eq $major) {
    Write-Missing 'Node.js is not installed.'
    $problems.Add("Node.js $MinimumNodeMajor or newer is not installed.")
    if (-not $CheckOnly) {
      Write-Fixing 'installing the current Node.js LTS'
      Install-NodeJs
      Write-Ok "Node.js $(Get-ExecutableDescription 'node')"
    }
  } elseif ($major -lt $MinimumNodeMajor) {
    Write-Missing "Node.js $(Get-ExecutableDescription 'node') is older than the required major version $MinimumNodeMajor."
    $problems.Add("Node.js is older than $MinimumNodeMajor.")
    if (-not $CheckOnly) {
      Write-Fixing 'installing the current Node.js LTS over it'
      Install-NodeJs
      Write-Ok "Node.js $(Get-ExecutableDescription 'node')"
    }
  } else {
    Write-Ok "Node.js $(Get-ExecutableDescription 'node')"
  }

  # --- corepack --------------------------------------------------------
  Write-Step 'corepack (provides the yarn version pinned in package.json)'
  if (Find-Executable 'corepack') {
    Write-Ok "corepack $(Get-ExecutableDescription 'corepack')"
  } else {
    Write-Missing 'corepack is not on the PATH.'
    $problems.Add('corepack is not available.')
    if (-not $CheckOnly) {
      Write-Fixing 'installing corepack from npm'
      Install-Corepack
      Write-Ok "corepack $(Get-ExecutableDescription 'corepack')"
    }
  }

  # --- Git -------------------------------------------------------------
  Write-Step 'Git (scripts/get-git-hash.js runs it during every build)'
  if (Find-Executable 'git') {
    Write-Ok (Get-ExecutableDescription 'git')
  } else {
    Write-Missing 'Git is not installed.'
    $problems.Add('Git is not installed.')
    if (-not $CheckOnly) {
      Write-Fixing 'installing the current Git for Windows'
      Install-Git
      Write-Ok (Get-ExecutableDescription 'git')
    }
  }

  # --- node_modules ----------------------------------------------------
  Write-Step 'node_modules'
  if (Test-DependenciesInstalled) {
    Write-Ok 'dependencies are installed'
  } else {
    Write-Missing 'node_modules is missing or was left half installed.'
    $problems.Add('node_modules is missing or incomplete.')
    if (-not $CheckOnly) {
      Write-Fixing 'running corepack yarn install'
      Install-Dependencies
      Write-Ok 'dependencies are installed'
    }
  }

  # --- Electron binaries -----------------------------------------------
  Write-Step 'Electron binaries in node_modules/electron/dist'
  $versions = Get-ElectronVersions
  if ($null -eq $versions) {
    if ($CheckOnly) {
      Write-Missing 'node_modules/electron is not installed.'
      $problems.Add('node_modules/electron is not installed.')
    } else {
      throw 'node_modules/electron is missing even after installing the dependencies.'
    }
  } elseif ($versions.Installed -eq $versions.Wanted) {
    Write-Ok "Electron $($versions.Installed)"
  } else {
    if ($null -eq $versions.Installed) {
      Write-Missing "the binaries are missing; package.json asks for Electron $($versions.Wanted)."
      $problems.Add('The Electron binaries are missing.')
    } else {
      Write-Missing "the binaries are Electron $($versions.Installed) but package.json asks for $($versions.Wanted)."
      $problems.Add("The Electron binaries are $($versions.Installed) instead of $($versions.Wanted).")
    }
    if (-not $CheckOnly) {
      Write-Fixing "downloading Electron $($versions.Wanted)"
      Repair-ElectronBinary
      Write-Ok "Electron $((Get-ElectronVersions).Installed)"
    }
  }
} catch {
  Write-Failure $_.Exception.Message
  Write-Host "    at       $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor Red
  Write-Host "    command  $($_.InvocationInfo.Line.Trim())" -ForegroundColor Red
  Write-Host '    stack trace:' -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
  try {
    if (-not (Test-Path $DownloadDirectory)) {
      New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
    }
    $failureLog = Join-Path $DownloadDirectory 'start-sandbox-failure.log'
    $failureText = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`r`n$($_ | Out-String)`r`n$($_.ScriptStackTrace)"
    [System.IO.File]::WriteAllText($failureLog, $failureText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "    The error was also saved to $failureLog" -ForegroundColor Red
  } catch {}
  Write-Host ''
  Write-Host '  The sandbox was not started. Fix the problem above and run this' -ForegroundColor Red
  Write-Host '  window again, or start Zettlr_LYH.exe once more.' -ForegroundColor Red
  exit 1
}

if ($CheckOnly) {
  Write-Host ''
  if ($problems.Count -eq 0) {
    Write-Host '  Everything the sandbox needs is in place.' -ForegroundColor Green
    exit 0
  }
  Write-Host "  $($problems.Count) problem(s) found:" -ForegroundColor Yellow
  foreach ($problem in $problems) {
    Write-Host "    - $problem" -ForegroundColor Yellow
  }
  Write-Host ''
  Write-Host '  Run this script without -CheckOnly, or start Zettlr_LYH.exe, to repair them.'
  exit 1
}

if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host "  Repaired $($problems.Count) problem(s)." -ForegroundColor Green
}

if ($RepairOnly) {
  Write-Host ''
  Write-Host '  The environment is ready; the sandbox is not started here.' -ForegroundColor Green
  exit 0
}

Write-Step 'corepack yarn start'
& (Find-Executable 'corepack') yarn start
exit $LASTEXITCODE
