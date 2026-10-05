# Sets up an isolated gcloud user-credential store for the HusshOne worker.
#
# Run explicitly from an interactive PowerShell session:
#   .\setup_dedicated_gcloud_account.ps1
#   .\setup_dedicated_gcloud_account.ps1 -Reauthenticate
#
# This script intentionally does not create Cloud IAM resources, alter Cloud SQL,
# retrieve any Secret Manager secret value, or create Application Default Credentials.

[CmdletBinding()]
param(
    # Forces the Google web flow even if the private credential store already has
    # a valid token for the dedicated account.
    [switch]$Reauthenticate,

    # Skips the post-login read-only Cloud SQL metadata check. This is useful only
    # when network access is intentionally unavailable during initial setup.
    [switch]$SkipCloudSqlCheck,

    # Keeps the three worker-specific settings in this PowerShell process only.
    # By default they are saved as current-user variables so a later scheduled
    # worker process can find its private gcloud configuration.
    [switch]$DoNotPersistWorkerSettings
)

$ErrorActionPreference = "Stop"

$account = "husshpuppy5@gmail.com"
$project = "hushh-tech-prod"
$instance = "hushh-directories-db"
$configurationName = "husshone-scraper"

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is not set; cannot create the per-user gcloud configuration."
}
$runtimeRoot = Join-Path $env:LOCALAPPDATA "HusshOne-Hotel-Scraper"
$gcloudConfigDirectory = Join-Path $runtimeRoot "gcloud"

# On this PC PowerShell resolves `gcloud` to gcloud.ps1, which can be blocked
# by the execution policy. Prefer the signed CLI command file explicitly.
$gcloud = $null
$gcloudCommand = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
if ($gcloudCommand) {
    $gcloud = $gcloudCommand.Source
}
if (-not $gcloud) {
    $gcloudCandidates = @()
    if ($env:ProgramFiles) {
        $gcloudCandidates += Join-Path $env:ProgramFiles "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
    }
    if (${env:ProgramFiles(x86)}) {
        $gcloudCandidates += Join-Path ${env:ProgramFiles(x86)} "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
    }
    $gcloud = $gcloudCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $gcloud) {
    throw "Google Cloud CLI command file (gcloud.cmd) was not found. Install the Google Cloud CLI, open a new PowerShell window, then rerun this script."
}

function Invoke-Gcloud {
    param(
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    # gcloud.cmd emits an informational line to stderr for a few otherwise
    # successful config commands. With this script's Stop preference, Windows
    # PowerShell would treat that line as a terminating NativeCommandError.
    $priorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $script:gcloud @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $priorErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "gcloud $($Arguments -join ' ') failed with exit code $exitCode."
    }
}

function Get-GcloudOutput {
    param(
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    # See Invoke-Gcloud: capture ordinary stdout while suppressing noisy
    # stderr without allowing a successful command to terminate the script.
    $priorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $script:gcloud @Arguments 2>$null)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $priorErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "gcloud $($Arguments -join ' ') failed with exit code $exitCode."
    }
    return $output
}

New-Item -ItemType Directory -Force -Path $gcloudConfigDirectory | Out-Null

# CLOUDSDK_CONFIG is deliberately scoped to this script process. Persisting it at
# the user level would redirect the operator's unrelated gcloud commands too.
$env:CLOUDSDK_CONFIG = $gcloudConfigDirectory

# These inherited variables take precedence over an account stored in a gcloud
# configuration. Clear them before any command so setup cannot accidentally
# validate a personal token, key file, or impersonated service account.
@(
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
    "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
    "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
    "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
    "CLOUDSDK_AUTH_DISABLE_CREDENTIALS",
    "CLOUDSDK_CORE_ACCOUNT",
    "CLOUDSDK_CORE_PROJECT",
    "CLOUDSDK_ACTIVE_CONFIG_NAME"
) | ForEach-Object { Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue }

$configurationNames = @(Get-GcloudOutput config configurations list --format="value(name)")

if ($configurationNames -notcontains $configurationName) {
    Invoke-Gcloud config configurations create $configurationName --no-activate
}

Invoke-Gcloud config configurations activate $configurationName

# A private configuration can still contain auth overrides that outrank its
# active account. Remove them idempotently before and after login; this writes
# only inside the worker's private CLOUDSDK_CONFIG directory.
@(
    "auth/access_token_file",
    "auth/credential_file_override",
    "auth/impersonate_service_account",
    "auth/disable_credentials"
) | ForEach-Object { Invoke-Gcloud config unset $_ --quiet }

Invoke-Gcloud config set project $project

$authenticatedAccounts = @(Get-GcloudOutput auth list --format="value(account)")
if ($Reauthenticate -or $authenticatedAccounts -notcontains $account) {
    $loginArguments = @("auth", "login", $account)
    if ($Reauthenticate) {
        $loginArguments += "--force"
    }
    Write-Host "Opening Google sign-in for $account..." -ForegroundColor Cyan
    Invoke-Gcloud @loginArguments
} else {
    Write-Host "Using the existing private gcloud login for $account." -ForegroundColor Cyan
}

# Pin the expected account only after the browser login (or existing private
# credential) is known to be present.
Invoke-Gcloud config set account $account
$activeAccountValues = @(Get-GcloudOutput auth list --filter="status:ACTIVE" --format="value(account)")
$activeAccount = [string]($activeAccountValues | Where-Object { $_ } | Select-Object -First 1)
if ($activeAccount.Trim() -ne $account) {
    throw "The isolated configuration did not activate $account. No worker settings were saved."
}
@(
    "auth/access_token_file",
    "auth/credential_file_override",
    "auth/impersonate_service_account",
    "auth/disable_credentials"
) | ForEach-Object { Invoke-Gcloud config unset $_ --quiet }
$env:CLOUDSDK_CORE_ACCOUNT = $account
$env:CLOUDSDK_CORE_PROJECT = $project

$activeProjectValues = @(Get-GcloudOutput config get-value project)
$activeProject = [string]($activeProjectValues | Where-Object { $_ } | Select-Object -First 1)
if ($activeProject.Trim() -ne $project) {
    throw "The isolated configuration did not retain project $project. No worker settings were saved."
}

if (-not $SkipCloudSqlCheck) {
    # Metadata only: this does not start a proxy, connect to PostgreSQL, expose
    # a password, or change Cloud SQL. roles/cloudsql.client includes the needed
    # cloudsql.instances.get permission.
    $connectionNameValues = @(Get-GcloudOutput sql instances describe $instance --project $project --format="value(connectionName)")
    $connectionName = [string]($connectionNameValues | Where-Object { $_ } | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($connectionName)) {
        throw "Signed in as $account, but the read-only Cloud SQL metadata check for $instance failed. Confirm this Google account can read the intended Cloud SQL instance in $project."
    }
    Write-Host "Read-only Cloud SQL metadata check passed: $($connectionName.Trim())" -ForegroundColor Green
}

# These names are consumed by the scraper only. They do not change the normal
# gcloud configuration used in the operator's other terminals. Keep persistent
# settings until after the requested post-login metadata check has passed.
$env:GCP_GCLOUD_CONFIG_DIR = $gcloudConfigDirectory
$env:GCP_GCLOUD_CONFIG_NAME = $configurationName
$env:GCP_GCLOUD_ACCOUNT = $account

if (-not $DoNotPersistWorkerSettings) {
    [Environment]::SetEnvironmentVariable("GCP_GCLOUD_CONFIG_DIR", $gcloudConfigDirectory, "User")
    [Environment]::SetEnvironmentVariable("GCP_GCLOUD_CONFIG_NAME", $configurationName, "User")
    [Environment]::SetEnvironmentVariable("GCP_GCLOUD_ACCOUNT", $account, "User")
}

Write-Host "Dedicated gcloud sign-in and private configuration are ready." -ForegroundColor Green
Write-Host "Private gcloud directory: $gcloudConfigDirectory"
Write-Host "Configuration: $configurationName"
Write-Host "Account: $account"
Write-Host "Project: $project"
if (-not $DoNotPersistWorkerSettings) {
    Write-Host "Saved worker-only settings for future processes. Restart an already-running worker or scheduled task before testing it." -ForegroundColor Yellow
}
Write-Host "This only verified Cloud SQL metadata. The app must still complete its own read-only proxy, secret-access, PostgreSQL, and schema preflight before writes are allowed." -ForegroundColor Yellow
Write-Host "No Application Default Credentials, service-account key, secret value, IAM policy, database role, or Cloud SQL data was created or changed." -ForegroundColor Yellow
