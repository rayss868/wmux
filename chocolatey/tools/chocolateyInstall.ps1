$ErrorActionPreference = 'Stop'

$version = $env:chocolateyPackageVersion
$url     = "https://github.com/openwong2kim/wmux/releases/download/v${version}/wmux-${version}.Setup.exe"

$packageArgs = @{
  packageName    = 'wmux'
  fileType       = 'exe'
  url64bit       = $url
  checksum64     = '__CHECKSUM_SHA256__'
  checksumType64 = 'sha256'
  silentArgs     = '--silent'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
