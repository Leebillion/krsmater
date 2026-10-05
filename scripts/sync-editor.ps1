# 마스터 편집(editor/)을 원본 프로젝트(masternew)에서 다시 복사한다.
# 감축·출력 규칙의 원본은 masternew(데스크톱 앱과 공용)이므로, editor/ 안의 코드는 직접 고치지 말고
# masternew에서 고친 뒤 이 스크립트로 가져온다.
#   powershell -ExecutionPolicy Bypass -File scripts\sync-editor.ps1 [-Source <masternew 경로>]
param(
  [string]$Source = "$env:USERPROFILE\Documents\cursor_work\masternew"
)
$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "..\editor" | Resolve-Path -ErrorAction SilentlyContinue
if (-not $target) { $target = New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "..\editor") }
$target = "$target"

if (-not (Test-Path "$Source\master_reducer\workspace.py")) { throw "원본 masternew를 찾을 수 없습니다: $Source" }

# 규칙 패키지: tkinter 화면(app.py, dialogs.py)은 서버에 필요 없으므로 제외
$rules = @("__init__.py", "core.py", "db.py", "outputs.py", "rules.py", "workbook_export.py", "workspace.py")
New-Item -ItemType Directory -Force "$target\master_reducer" | Out-Null
Get-ChildItem "$target\master_reducer" -Filter *.py | Remove-Item
foreach ($file in $rules) { Copy-Item "$Source\master_reducer\$file" "$target\master_reducer\$file" }

# 웹 서버·화면·테스트
foreach ($dir in @("server", "static", "tests")) {
  if (Test-Path "$target\$dir") { Remove-Item -Recurse -Force "$target\$dir" }
  Copy-Item -Recurse "$Source\web_app\$dir" "$target\$dir"
}
Get-ChildItem $target -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
Copy-Item "$Source\web_app\requirements.txt" "$target\requirements.txt"

$commit = $null
try { $commit = (git -C $Source rev-parse --short HEAD 2>$null) } catch { }
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
Set-Content -Encoding utf8 "$target\SOURCE.txt" "masternew에서 복사: $stamp $(if ($commit) { "(커밋 $commit)" } else { "(git 커밋 없음)" })"
Write-Host "editor 동기화 완료 -> $target"
