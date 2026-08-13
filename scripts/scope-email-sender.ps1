<#
.SYNOPSIS
  Locks the "Kompis Split Mail" app down to a single sender mailbox.

.DESCRIPTION
  The Graph "Mail.Send" APPLICATION permission granted by setup-email-integration.ps1 lets the
  app send mail as ANY mailbox in your tenant by default. This script adds an Exchange Online
  Application Access Policy so it can only ever send as the one mailbox you choose — if the
  client secret ever leaks, the blast radius is one mailbox, not the whole tenant.

  The policy is scoped through a mail-enabled security group containing just that one mailbox,
  rather than pointing directly at the mailbox. Microsoft's own guidance recommends this even
  for a single mailbox — pointing New-ApplicationAccessPolicy straight at a mailbox is known to
  sometimes fail with "the identity of the policy scope is not a security principal" even when
  the mailbox is fully set up and synced; going through a group avoids that.

  Run this AFTER setup-email-integration.ps1. You'll need the App (client) ID it printed and
  the same sender mailbox address. Requires an Exchange admin role in your tenant.

.NOTES
  Safe to re-run: reuses the security group and reports the policy already exists if you run
  it twice for the same app/mailbox pair.
#>

$ErrorActionPreference = "Stop"

if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
  Write-Host "PowerShell-modulen ExchangeOnlineManagement saknas. Installerar (för aktuell användare)..." -ForegroundColor Yellow
  Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser -Force
}
Import-Module ExchangeOnlineManagement

Write-Host "== Kompis Split e-postintegration: steg 2 av 2 (begränsa avsändare) ==" -ForegroundColor Green
Write-Host "Ansluter till Exchange Online (webbläsarinloggning öppnas)..."
Connect-ExchangeOnline -ShowBanner:$false

$appId = Read-Host "App (client) ID (samma som setup-email-integration.ps1 skrev ut)"
$mailbox = Read-Host "Avsändaradress som appen ska få skicka som (t.ex. no-reply@dittdomän.se)"
$domain = $mailbox.Split("@")[1]
$groupSmtp = "kompis-split-senders@$domain"

Write-Host ""
Write-Host "Kontrollerar mailaktiverad säkerhetsgrupp ($groupSmtp)..."
$group = Get-DistributionGroup -Identity $groupSmtp -ErrorAction SilentlyContinue
if (-not $group) {
  Write-Host "Skapar grupp och lägger till $mailbox som medlem..."
  New-DistributionGroup -Name "Kompis Split Senders" -Type Security -PrimarySmtpAddress $groupSmtp -Members $mailbox | Out-Null
} else {
  Write-Host "Återanvänder befintlig grupp." -ForegroundColor Yellow
  $isMember = Get-DistributionGroupMember -Identity $groupSmtp | Where-Object { $_.PrimarySmtpAddress -eq $mailbox }
  if (-not $isMember) {
    Write-Host "Lägger till $mailbox i gruppen..."
    Add-DistributionGroupMember -Identity $groupSmtp -Member $mailbox
  }
}

Write-Host ""
Write-Host "Skapar Application Access Policy: $appId får bara skicka som medlemmar i $groupSmtp..."
New-ApplicationAccessPolicy `
  -AppId $appId `
  -PolicyScopeGroupId $groupSmtp `
  -AccessRight RestrictAccess `
  -Description "Kompis Split Mail - endast $mailbox"

Write-Host ""
Write-Host "Verifierar policyn..."
$result = Test-ApplicationAccessPolicy -AppId $appId -Identity $mailbox
Write-Host "Resultat för $mailbox (ska vara 'Granted'):" -ForegroundColor Cyan
$result | Format-List AccessCheckResult, Details

Write-Host ""
Write-Host "Klart. Appen kan nu bara skicka mail som $mailbox." -ForegroundColor Green
Write-Host "(Policyn kan ta upp till 30 minuter innan den slår igenom fullt ut i Exchange Online.)" -ForegroundColor Yellow

Disconnect-ExchangeOnline -Confirm:$false
