# Frees the dev ports.
#
# Killing whatever is listening is not enough. The API runs under
# `node --watch`, which is a supervisor: kill the child holding the port and it
# cheerfully starts another one, so the port looks busy again a second later and
# the next `npm run dev` dies with EADDRINUSE. When the listener's parent is a
# watcher, the parent is what has to go.
#
# ASCII only, on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI, so a UTF-8
# dash or quote arrives as mojibake and can terminate a string mid-line.

param([int[]]$Ports = @(5000, 5173))

$killed = @()

foreach ($port in $Ports) {
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)

  foreach ($c in $connections) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }

    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue

    # Take the supervisor down with the child, or it will respawn it.
    if ($parent -and $parent.CommandLine -like '*--watch*') {
      $target = $parent
    } else {
      $target = $proc
    }

    $null = taskkill /PID $target.ProcessId /T /F
    $killed += "port $port -> PID $($target.ProcessId)"
  }
}

# Give the OS a moment to release the sockets before reporting.
Start-Sleep -Milliseconds 800

$stillBusy = @()
foreach ($port in $Ports) {
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    $stillBusy += $port
  }
}

foreach ($k in $killed) { Write-Host "stopped $k" }

if ($stillBusy.Count -gt 0) {
  Write-Host "STILL BUSY: $($stillBusy -join ', '). Something outside this project is using them." -ForegroundColor Yellow
  exit 1
}

Write-Host "ports $($Ports -join ' and ') are free" -ForegroundColor Green
