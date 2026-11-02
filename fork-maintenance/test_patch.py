"""Offline smoke tests for patch anchors, idempotence, and JS syntax."""
import importlib.util
import subprocess
import tempfile
from pathlib import Path

here=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('bridge',here/'apply_to_nuvio.py')
bridge=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
with tempfile.TemporaryDirectory() as d:
    root=Path(d)
    for file, changes in bridge.PATCHES.items():
        path=root/file
        path.parent.mkdir(parents=True,exist_ok=True)
        if file==bridge.PARTY_JS:
            body='''const partyElement = () => ({appendChild() {}});
const partyButtonElement = () => ({});
const buildPartyHostSettings = party => { return {}; };
function render(party, content) {
  if (party.isHost) content.appendChild(buildPartyHostSettings(party));
}
'''
        else:
            body='package com.nuvio.app.features.player\n'+''.join(before+'\n' for before,after in changes)
        path.write_text(body,encoding='utf8')
    bridge.apply(root,True)
    bridge.apply(root,False)
    before={p:(root/p).read_bytes() for p in bridge.PATCHES}
    bridge.apply(root,False)
    assert before=={p:(root/p).read_bytes() for p in bridge.PATCHES}, 'patch is not idempotent'
    for p in bridge.PATCHES:
        assert (root/p).with_suffix(p.suffix+'.pre-browser-bridge.bak').is_file()
    result=subprocess.run(['node','--check',str(root/bridge.PARTY_JS)],capture_output=True,text=True)
    assert result.returncode==0,result.stderr
print(f'Patch smoke tests passed: {len(bridge.PATCHES)} files; JavaScript syntax; backups and idempotence')
