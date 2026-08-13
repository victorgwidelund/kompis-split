<#
.SYNOPSIS
  One-time setup: registers an Entra ID app that Kompis Split can use to send transactional
  email (password reset, etc.) via Microsoft Graph — not SMTP, since Exchange Online is
  phasing out SMTP AUTH.

.DESCRIPTION
  Uses the Microsoft.Graph PowerShell SDK directly (no Azure CLI, no Azure subscription
  needed — just Entra ID, which every Microsoft 365 tenant already has). This script only
  touches YOUR tenant. It never talks to the Kompis Split server or repository — it just
  prints the values you paste into the app's environment config (.env / Compose Manager)
  yourself, the same way you already handle APP_PASSWORD/COOKIE_SECRET.

  What it does, step by step:
    1. Installs the Microsoft.Graph.Applications module if missing and signs you in
       interactively (browser login) with just the scopes needed for this task.
    2. Creates a single-tenant app registration called "Kompis Split Mail" (reuses it if you
       run the script again instead of creating a duplicate).
    3. Grants it the Microsoft Graph "Mail.Send" APPLICATION permission (send-as-any-mailbox)
       by creating the app role assignment directly — this IS the admin-consent step, so you
       need to be a Global Admin or Privileged Role Admin in your tenant for it to succeed.
    4. Creates a client secret (shown ONCE — copy it immediately, Microsoft will not show it
       again).
    5. Asks which mailbox should be the "From" address and prints a ready-to-paste block of
       environment variables.

  SECURITY NOTE: Mail.Send as an application permission can send mail as ANY mailbox in your
  tenant, not just the one you intend to use. Run scripts/scope-email-sender.ps1 (Exchange
  Online, separate script) afterwards to lock the app down to only the one sender mailbox —
  strongly recommended, takes two minutes.

.NOTES
  Safe to re-run: it detects and reuses an existing "Kompis Split Mail" app registration
  instead of creating duplicates. It will NOT create a second client secret unless you
  explicitly confirm — secrets can't be retrieved again after creation, only rotated.
#>

$ErrorActionPreference = "Stop"
$appName = "Kompis Split Mail"
$graphResourceAppId = "00000003-0000-0000-c000-000000000000" # Microsoft Graph, well-known/unchanging
$mailSendAppPermissionId = "b633e1c5-b582-4048-a93e-9f11b44c7e96" # Graph "Mail.Send", Application (not Delegated)

function Assert-GraphModule {
  if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Applications)) {
    Write-Host "PowerShell-modulen Microsoft.Graph.Applications saknas. Installerar (för aktuell användare)..." -ForegroundColor Yellow
    Install-Module -Name Microsoft.Graph.Applications -Scope CurrentUser -Force
  }
  Import-Module Microsoft.Graph.Applications
}

Write-Host "== Kompis Split e-postintegration: steg 1 av 2 (app-registrering) ==" -ForegroundColor Green
Assert-GraphModule

Write-Host "Loggar in mot Microsoft Graph (webbläsarinloggning öppnas)..."
Connect-MgGraph -Scopes "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All" -NoWelcome

$context = Get-MgContext
$tenantId = $context.TenantId
Write-Host ""
Write-Host "Inloggad som: $($context.Account)"
Write-Host "Tenant-ID:    $tenantId"
Write-Host ""
$confirm = Read-Host "Fortsätt med den här tenanten? (j/n)"
if ($confirm -notin @("j", "J", "y", "Y")) { Write-Host "Avbrutet."; Disconnect-MgGraph | Out-Null; exit 0 }

# --- Reuse an existing app registration if one from a previous run exists ---
Write-Host ""
Write-Host "Letar efter befintlig app-registrering med namnet '$appName'..."
$app = Get-MgApplication -Filter "displayName eq '$appName'" -ConsistencyLevel eventual -CountVariable appCount | Select-Object -First 1
if ($app) {
  Write-Host "Hittade en befintlig app: $($app.AppId) (återanvänder den i stället för att skapa en ny)" -ForegroundColor Yellow
} else {
  Write-Host "Skapar ny app-registrering..."
  $app = New-MgApplication -DisplayName $appName -SignInAudience "AzureADMyOrg"
  Write-Host "Skapad. App (client) ID: $($app.AppId)" -ForegroundColor Green
}
$appObjectId = $app.Id
$clientId = $app.AppId

# Declare the intended permission on the app registration itself (cosmetic — shows up
# correctly in the Portal's "API permissions" tab; the actual grant happens below).
Update-MgApplication -ApplicationId $appObjectId -RequiredResourceAccess @(
  @{ ResourceAppId = $graphResourceAppId; ResourceAccess = @(@{ Id = $mailSendAppPermissionId; Type = "Role" }) }
) | Out-Null

# --- Ensure a service principal exists for the app (needed to grant it a permission) ---
Write-Host ""
Write-Host "Kontrollerar service principal..."
$clientSp = Get-MgServicePrincipal -Filter "appId eq '$clientId'" -ConsistencyLevel eventual -CountVariable spCount | Select-Object -First 1
if (-not $clientSp) {
  Write-Host "Skapar service principal..."
  # A newly created app registration can take a few seconds to replicate before a service
  # principal can be created against it — retry a few times instead of failing immediately.
  $attempt = 0
  do {
    $attempt++
    try { $clientSp = New-MgServicePrincipal -AppId $clientId }
    catch { Write-Host "  ...väntar på att app-registreringen ska bli synlig (försök $attempt/6)"; Start-Sleep -Seconds 5 }
  } while (-not $clientSp -and $attempt -lt 6)
  if (-not $clientSp) { throw "Kunde inte skapa service principal efter flera försök. Kör skriptet igen om en stund." }
}

# --- Grant the Mail.Send application permission (this call itself IS the admin consent) ---
Write-Host ""
Write-Host "Beviljar Microsoft Graph-behörigheten Mail.Send (application)..."
Write-Host "(kräver att du är Global Admin eller Privileged Role Admin i tenanten)"
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphResourceAppId'" -ConsistencyLevel eventual -CountVariable graphSpCount | Select-Object -First 1

$alreadyGranted = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $clientSp.Id |
  Where-Object { $_.ResourceId -eq $graphSp.Id -and $_.AppRoleId -eq $mailSendAppPermissionId }

if ($alreadyGranted) {
  Write-Host "Redan beviljat sedan tidigare." -ForegroundColor Yellow
  $consented = $true
} else {
  $attempt = 0
  $consented = $false
  do {
    $attempt++
    try {
      New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $clientSp.Id -PrincipalId $clientSp.Id -ResourceId $graphSp.Id -AppRoleId $mailSendAppPermissionId | Out-Null
      $consented = $true
    } catch {
      Write-Host "  ...försöker igen (försök $attempt/6)"
      Start-Sleep -Seconds 5
    }
  } while (-not $consented -and $attempt -lt 6)
}
if ($consented) {
  Write-Host "Beviljat." -ForegroundColor Green
} else {
  Write-Host "Det gick inte att bevilja behörigheten automatiskt." -ForegroundColor Yellow
  Write-Host "Bevilja manuellt i Azure Portal: Entra ID -> App registrations -> '$appName' -> API permissions -> Grant admin consent."
}

# --- Client secret ---
Write-Host ""
$makeSecret = Read-Host "Skapa en ny klienthemlighet (client secret) nu? Gammal hemlighet (om någon) påverkas inte. (j/n)"
$clientSecret = $null
if ($makeSecret -in @("j", "J", "y", "Y")) {
  $credential = Add-MgApplicationPassword -ApplicationId $appObjectId -PasswordCredential @{
    DisplayName = "kompis-split-mail-secret"
    EndDateTime = (Get-Date).AddYears(2)
  }
  $clientSecret = $credential.SecretText
}

# --- Sender mailbox ---
Write-Host ""
$senderEmail = Read-Host "Vilken brevlåda/e-postadress ska skicka mailen (t.ex. no-reply@dittdomän.se)?"

Write-Host ""
Write-Host "== Klart. Lägg till dessa i Kompis Splits miljövariabler (.env / Compose Manager): ==" -ForegroundColor Green
Write-Host ""
Write-Host "GRAPH_TENANT_ID=$tenantId"
Write-Host "GRAPH_CLIENT_ID=$clientId"
if ($clientSecret) { Write-Host "GRAPH_CLIENT_SECRET=$clientSecret" -ForegroundColor Cyan } else { Write-Host "GRAPH_CLIENT_SECRET=<oförändrad, ingen ny hemlighet skapades den här gången>" }
Write-Host "GRAPH_SENDER_EMAIL=$senderEmail"
Write-Host ""
if ($clientSecret) {
  Write-Host "VIKTIGT: kopiera GRAPH_CLIENT_SECRET nu. Microsoft visar den aldrig igen." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Nästa steg (starkt rekommenderat): kör scripts/scope-email-sender.ps1 för att begränsa" -ForegroundColor Yellow
Write-Host "appen till att bara kunna skicka som $senderEmail, i stället för valfri brevlåda i tenanten." -ForegroundColor Yellow

Disconnect-MgGraph | Out-Null
