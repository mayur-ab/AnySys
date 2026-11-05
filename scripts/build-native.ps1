$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    throw 'The 64-bit .NET Framework 4.x C# compiler is required.'
}
$output = Join-Path $root 'build/AnySys.Input.exe'
New-Item -ItemType Directory -Force (Split-Path -Parent $output) | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$output" (Join-Path $root 'native/Input.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
