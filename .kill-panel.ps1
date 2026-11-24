$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
  $cl = $p.CommandLine
  if ($cl -like '*vibe-panel*server.mjs*') {
    Write-Output ("KILL PID=" + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force
  }
}
Write-Output "SCAN_DONE"
