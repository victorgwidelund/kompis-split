<#
.SYNOPSIS
  One-time setup: registers an Azure AD (Entra ID) app that Kompis Split can use to send
  transactional email (password reset, etc.) via Microsoft Graph — not SMTP, since Exchange
  Online is phasing out SMTP AUTH.

.DESCRIPTION
  This script only touches YOUR Microsoft 365 tenant. It never talks to the Kompis Split
  server or repository — it just prints the values you paste into the app's environment
  config (.env / Compose Manager) yourself, the same way you already handle
  APP_PASSWORD/COOKIE_SECRET.

  What it does, step by step:
    1. Makes sure the Azure CLI is installed and you're logged in (interactive browser login).
    2. Creates a single-tenant app registration called "Kompis Split Mail" (reuses it if you
       run the script again instead of creating a duplicate).
    3. Grants it the Microsoft Graph "Mail.Send" APPLICATION permission (send-as-any-mailbox)
       and requests admin consent — you need to be a Global Admin or Application Admin in
       your tenant for the consent step to succeed.
    4. Creates a client secret (shown ONCE — copy it immediately, Azure will not show it again).
    5. Asks which mailbox should be the "From" address and prints a ready-to-paste block of
       environment variables.

  SECURITY NOTE: Mail.Send as an application permission can send mail as ANY mailbox in your
  tenant, not just the one you intend to use. Run
  scripts/scope-email-sender.ps1 (Exchange Online, separate script) afterwards to lock the
  app down to only the one sender mailbox — strongly recommended, takes two minutes.

.NOTES
  Safe to re-run: it detects and reuses an existing "Kompis Split Mail" app registration
  instead of creating duplicates. It will NOT create a second client secret unless you
  explicitly confirm — secrets can't be retrieved again after creation, only rotated.
#>

$ErrorActionPreference = "Stop"
$appName = "Kompis Split Mail"
$graphResourceId = "00000003-0000-0000-c000-000000000000" # Microsoft Graph, well-known/unchanging
$mailSendAppPermissionId = "b633e1c5-b582-4048-a93e-9f11b44c7e96" # Graph "Mail.Send", Application (not Delegated)

function Assert-AzureCli {
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Host "Azure CLI (az) hittades inte." -ForegroundColor Yellow
    Write-Host "Installera det, till exempel med:" -ForegroundColor Yellow
    Write-Host "  winget install Microsoft.AzureCLI" -ForegroundColor Cyan
    Write-Host "Starta sedan om terminalen och kör det här skriptet igen."
    exit 1
  }
}

function Assert-AzureLogin {
  try {
    az account show --output none 2>$null
    if ($LASTEXITCODE -ne 0) { throw "not logged in" }
  } catch {
    Write-Host "Du är inte inloggad i Azure CLI. Öppnar webbläsarinloggning..." -ForegroundColor Yellow
    az login --output none
    if ($LASTEXITCODE -ne 0) { throw "Inloggningen misslyckades." }
  }
}

Write-Host "== Kompis Split e-postintegration: steg 1 av 2 (app-registrering) ==" -ForegroundColor Green
Assert-AzureCli
Assert-AzureLogin

$tenantId = az account show --query tenantId -o tsv
$account = az account show --query "{name:user.name, subscription:name}" -o json | ConvertFrom-Json
Write-Host ""
Write-Host "Inloggad som: $($account.name)"
Write-Host "Tenant-ID:    $tenantId"
Write-Host ""
$confirm = Read-Host "Fortsätt med den här tenanten? (j/n)"
if ($confirm -notin @("j", "J", "y", "Y")) { Write-Host "Avbrutet."; exit 0 }

# --- Reuse an existing app registration if one from a previous run exists ---
Write-Host ""
Write-Host "Letar efter befintlig app-registrering med namnet '$appName'..."
$existingAppId = az ad app list --display-name $appName --query "[0].appId" -o tsv
if ($existingAppId) {
  Write-Host "Hittade en befintlig app: $existingAppId (återanvänder den i stället för att skapa en ny)" -ForegroundColor Yellow
  $appId = $existingAppId
} else {
  Write-Host "Skapar ny app-registrering..."
  $appId = az ad app create --display-name $appName --sign-in-audience "AzureADMyOrg" --query appId -o tsv
  Write-Host "Skapad. App (client) ID: $appId" -ForegroundColor Green
}

# --- Ensure a service principal exists (needed for admin consent) ---
Write-Host ""
Write-Host "Kontrollerar service principal..."
$spExists = az ad sp show --id $appId --query id -o tsv 2>$null
if (-not $spExists) {
  Write-Host "Skapar service principal..."
  # Newly created app registrations can take a few seconds to replicate before a service
  # principal can be created against them — retry a few times instead of failing immediately.
  $attempt = 0
  do {
    $attempt++
    try { az ad sp create --id $appId --output none; $spExists = $true }
    catch { Write-Host "  ...väntar på att app-registreringen ska bli synlig (försök $attempt/6)"; Start-Sleep -Seconds 5 }
  } while (-not $spExists -and $attempt -lt 6)
  if (-not $spExists) { throw "Kunde inte skapa service principal efter flera försök. Kör skriptet igen om en stund." }
}

# --- Grant the Mail.Send application permission and request admin consent ---
Write-Host ""
Write-Host "Lägger till Microsoft Graph-behörigheten Mail.Send (application)..."
az ad app permission add --id $appId --api $graphResourceId --api-permissions "$mailSendAppPermissionId=Role" --output none
Write-Host "Begär admin-consent (kräver Global Admin eller Application Admin i tenanten)..."
$attempt = 0
$consented = $false
do {
  $attempt++
  try { az ad app permission admin-consent --id $appId --output none; $consented = $true }
  catch { Write-Host "  ...försöker igen (försök $attempt/6)"; Start-Sleep -Seconds 5 }
} while (-not $consented -and $attempt -lt 6)
if (-not $consented) {
  Write-Host "Admin-consent misslyckades automatiskt." -ForegroundColor Yellow
  Write-Host "Ge samtycke manuellt i Azure Portal: Entra ID -> App registrations -> '$appName' -> API permissions -> Grant admin consent."
} else {
  Write-Host "Admin-consent beviljat." -ForegroundColor Green
}

# --- Client secret ---
Write-Host ""
$makeSecret = Read-Host "Skapa en ny klienthemlighet (client secret) nu? Gammal hemlighet (om någon) påverkas inte. (j/n)"
$clientSecret = $null
if ($makeSecret -in @("j", "J", "y", "Y")) {
  $secretJson = az ad app credential reset --id $appId --display-name "kompis-split-mail-secret" --years 2 --query "{password:password}" -o json | ConvertFrom-Json
  $clientSecret = $secretJson.password
}

# --- Sender mailbox ---
Write-Host ""
$senderEmail = Read-Host "Vilken brevlåda/e-postadress ska skicka mailen (t.ex. no-reply@dittdomän.se)?"

Write-Host ""
Write-Host "== Klart. Lägg till dessa i Kompis Splits miljövariabler (.env / Compose Manager): ==" -ForegroundColor Green
Write-Host ""
Write-Host "GRAPH_TENANT_ID=$tenantId"
Write-Host "GRAPH_CLIENT_ID=$appId"
if ($clientSecret) { Write-Host "GRAPH_CLIENT_SECRET=$clientSecret" -ForegroundColor Cyan } else { Write-Host "GRAPH_CLIENT_SECRET=<oförändrad, ingen ny hemlighet skapades den här gången>" }
Write-Host "GRAPH_SENDER_EMAIL=$senderEmail"
Write-Host ""
if ($clientSecret) {
  Write-Host "VIKTIGT: kopiera GRAPH_CLIENT_SECRET nu. Azure visar den aldrig igen." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Nästa steg (starkt rekommenderat): kör scripts/scope-email-sender.ps1 för att begränsa" -ForegroundColor Yellow
Write-Host "appen till att bara kunna skicka som $senderEmail, i stället för valfri brevlåda i tenanten." -ForegroundColor Yellow
