# EndpointX PowerShell Profile
# Adds logo display on PowerShell startup

function Show-EndpointXLogo {
    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║                                           ║" -ForegroundColor Cyan
    Write-Host "  ║        ███████╗███████╗███╗   ██╗        ║" -ForegroundColor Cyan
    Write-Host "  ║        ██╔════╝██╔════╝████╗  ██║        ║" -ForegroundColor Cyan
    Write-Host "  ║        █████╗  █████╗  ██╔██╗ ██║        ║" -ForegroundColor Cyan
    Write-Host "  ║        ██╔══╝  ██╔══╝  ██║╚██╗██║        ║" -ForegroundColor Cyan
    Write-Host "  ║        ██║     ███████╗██║ ╚████║        ║" -ForegroundColor Cyan
    Write-Host "  ║        ╚═╝     ╚══════╝╚═╝  ╚═══╝        ║" -ForegroundColor Cyan
    Write-Host "  ║                                           ║" -ForegroundColor Cyan
    Write-Host "  ║      Endpoint Management System v1.0     ║" -ForegroundColor Gray
    Write-Host "  ║                                           ║" -ForegroundColor Cyan
    Write-Host "  ╚═══════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

Show-EndpointXLogo
