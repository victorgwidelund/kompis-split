<#
.SYNOPSIS
  Sends one real test email through Microsoft Graph to verify the setup from
  setup-email-integration.ps1 (and, if run, scope-email-sender.ps1) actually works.

.DESCRIPTION
  This talks to Microsoft Graph directly with app-only (client credentials) auth — exactly the
  way Kompis Split itself will eventually send password-reset emails — so a successful run here
  proves the whole chain works: app registration, Mail.Send permission, admin consent, and (if
  you ran it) the Application Access Policy scoping. No Kompis Split code is involved; this is
  a standalone check you can re-run any time (e.g. after rotating the client secret).

  Nothing is written to disk and the client secret is never displayed or logged.

.NOTES
  If GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_SENDER_EMAIL are already set as environment
  variables (e.g. you exported them after running setup-email-integration.ps1), this script
  uses them instead of asking. The client secret is always prompted for, never read from an
  environment variable, so it can't linger in shell history.
#>

$ErrorActionPreference = "Stop"

$tenantId = if ($env:GRAPH_TENANT_ID) { $env:GRAPH_TENANT_ID } else { Read-Host "Tenant-ID (GRAPH_TENANT_ID)" }
$clientId = if ($env:GRAPH_CLIENT_ID) { $env:GRAPH_CLIENT_ID } else { Read-Host "App (client) ID (GRAPH_CLIENT_ID)" }
$senderEmail = if ($env:GRAPH_SENDER_EMAIL) { $env:GRAPH_SENDER_EMAIL } else { Read-Host "Avsändaradress (GRAPH_SENDER_EMAIL)" }
$secureSecret = Read-Host "Client secret (GRAPH_CLIENT_SECRET)" -AsSecureString
$clientSecret = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret))
$recipientEmail = Read-Host "Skicka testmail till (din egen adress fungerar bra)"

function Send-GraphTestMail {
  param([string]$Token, [string]$From, [string]$To)
  $mail = @{
    message         = @{
      subject      = "Kompis Split - testmail"
      body         = @{ contentType = "Text"; content = "Det här är ett testmail som bekräftar att Microsoft Graph-integrationen för Kompis Split fungerar." }
      toRecipients = @(@{ emailAddress = @{ address = $To } })
    }
    saveToSentItems = $false
  } | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Method Post -Uri "https://graph.microsoft.com/v1.0/users/$From/sendMail" -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $mail
}

Write-Host ""
Write-Host "Hämtar access token..."
$tokenResponse = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token" -Body @{
  client_id     = $clientId
  client_secret = $clientSecret
  scope         = "https://graph.microsoft.com/.default"
  grant_type    = "client_credentials"
}
$token = $tokenResponse.access_token
Write-Host "Token hämtad." -ForegroundColor Green

Write-Host ""
Write-Host "Skickar testmail från $senderEmail till $recipientEmail..."
try {
  Send-GraphTestMail -Token $token -From $senderEmail -To $recipientEmail
  Write-Host "Skickat! Kolla mottagarens inkorg (och skräppost) om det inte dyker upp direkt." -ForegroundColor Green
} catch {
  Write-Host "Misslyckades:" -ForegroundColor Red
  Write-Host $_.ErrorDetails.Message -ForegroundColor Red
  Write-Host ""
  Write-Host "Vanliga orsaker: behörigheten Mail.Send har inte hunnit propagera än (vänta någon minut" -ForegroundColor Yellow
  Write-Host "och försök igen), eller Application Access Policy blockerar avsändaren (kontrollera att" -ForegroundColor Yellow
  Write-Host "$senderEmail verkligen ligger i kompis-split-senders@<domän>-gruppen)." -ForegroundColor Yellow
  throw
}

Write-Host ""
$testScope = Read-Host "Vill du också verifiera att Application Access Policy faktiskt begränsar avsändare? Ange en ANNAN brevlåda i tenanten att testa (eller tryck Enter för att hoppa över)"
if ($testScope) {
  Write-Host "Försöker skicka som $testScope (ska misslyckas med 403/ErrorAccessDenied om policyn fungerar)..."
  try {
    Send-GraphTestMail -Token $token -From $testScope -To $recipientEmail
    Write-Host "OVÄNTAT: lyckades skicka som $testScope. Application Access Policy begränsar INTE avsändare som tänkt." -ForegroundColor Red
  } catch {
    Write-Host "Blockerades som förväntat: $($_.ErrorDetails.Message)" -ForegroundColor Green
    Write-Host "Application Access Policy fungerar — appen kan bara skicka som $senderEmail." -ForegroundColor Green
  }
}
