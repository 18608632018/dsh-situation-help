param([switch]$CompileOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml, System.Web.Extensions
$assemblies = @('PresentationFramework', 'PresentationCore', 'WindowsBase', 'System.Xaml', 'System.Web.Extensions') |
  ForEach-Object { [Reflection.Assembly]::LoadWithPartialName($_).Location }
Add-Type -Path (Join-Path $PSScriptRoot 'DesktopTutor.cs') -ReferencedAssemblies $assemblies
$env:DESKTOP_TUTOR_MASCOT = Join-Path $PSScriptRoot 'mascot.png'
if (-not $CompileOnly) { [DesktopTutor.Shell]::Run() }
