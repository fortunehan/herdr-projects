/** Complete, read-only Git observation for Changes Review. Display caps never enter this boundary. */
export const CAPTURE = String.raw`
import hashlib, json, os, stat, subprocess, sys
p = json.loads(sys.argv[1])
if p.get('on'): raise ValueError('Review supports local checkouts only')
if p.get('pending'): raise ValueError('The review target is still loading')
if p.get('retained'): raise ValueError('The task worktree is gone; a retained branch cannot be reviewed')
cwd = p.get('cwd')
if not cwd or not os.path.isdir(cwd): raise ValueError('The checkout is missing or was removed')
def git(*args, required=True):
    r = subprocess.run(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false', *args], cwd=cwd, capture_output=True)
    if required and r.returncode: raise ValueError(r.stderr.decode(errors='replace').strip() or 'Git comparison failed')
    return r
root = git('rev-parse', '--show-toplevel').stdout.decode().strip()
if os.path.realpath(root) != os.path.realpath(cwd):
    cwd = root
head_r = git('rev-parse', '--verify', 'HEAD', required=False)
head = head_r.stdout.decode().strip() if head_r.returncode == 0 else None
mode = p.get('mode', 'uncommitted')
if mode not in ['uncommitted', 'base', 'ref']: raise ValueError('Unknown comparison mode')
def verified(ref):
    return bool(ref) and not ref.startswith('-') and git('rev-parse', '--verify', '--quiet', ref+'^{commit}', required=False).returncode == 0
label = resolved = base = None
if mode != 'uncommitted':
    if not head: raise ValueError('No commits yet: choose Uncommitted')
    fixed = p.get('fixed')
    if fixed:
        label, resolved, base = fixed['ref'], fixed['resolvedRef'], fixed['base']
        if not verified(base): raise ValueError('The captured base commit is no longer available')
    elif mode == 'ref':
        label = p.get('ref') or git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}', required=False).stdout.decode().strip()
        if not verified(label): raise ValueError('Unknown or missing branch/ref')
    else:
        configured = git('config', '--get', 'herdr.base', required=False).stdout.decode().strip()
        remote = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD', required=False).stdout.decode().strip()
        task = p.get('base')
        tries = ([task, 'origin/'+task] if task else []) + ([configured, 'origin/'+configured] if configured else []) + [remote, 'origin/main', 'origin/master', 'main', 'master']
        label = next((r for r in tries if verified(r)), None)
        if not label: raise ValueError('No base found: set git config herdr.base')
    if not fixed:
        resolved = git('rev-parse', '--verify', label+'^{commit}').stdout.decode().strip()
        base = git('merge-base', head, resolved).stdout.decode().strip()
status = git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all').stdout
entries = [e for e in status.split(b'\0') if e]
if any(b'U' in e[:2] or e[:2] in [b'AA', b'DD'] for e in entries): raise ValueError('Resolve merge conflicts before Review')
flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames']
if mode == 'uncommitted':
    names = [(e[:2].decode(), e[3:]) for e in entries]
    patches = [git('diff', '--cached', *([head] if head else []), *flags, '--binary').stdout, git('diff', *flags, '--binary').stdout]
else:
    parts = git('diff', base, '--name-status', '-z', '--no-renames').stdout.split(b'\0')
    names = [(parts[i].decode(), parts[i+1]) for i in range(0, len(parts)-1, 2)]
    names += [('??', f) for f in git('ls-files', '--others', '--exclude-standard', '-z').stdout.split(b'\0') if f]
    patches = [git('diff', base, *flags, '--binary').stdout]
if not names: raise ValueError('There are no changes in this comparison')
inventory, limitations = [], []
for xy, raw in sorted(names, key=lambda x: x[1]):
    path = os.fsdecode(raw)
    item = {'path': path, 'status': xy}
    try:
        f = os.path.join(cwd, path)
        s = os.lstat(f)
        if stat.S_ISLNK(s.st_mode):
            data = os.fsencode(os.readlink(f)); item['limitation'] = 'Symbolic link: inspect the link, not its external target'
        elif stat.S_ISREG(s.st_mode):
            with open(f, 'rb') as stream: data = stream.read()
            if b'\0' in data: item['limitation'] = 'Binary content requires separate inspection'
            else:
                try: data.decode('utf-8')
                except UnicodeDecodeError: item['limitation'] = 'Content is not UTF-8 text'
        else:
            data = b''; item['limitation'] = 'Submodule or non-regular file requires separate inspection'
        item.update(size=s.st_size, mtime=s.st_mtime_ns, digest=hashlib.sha256(data).hexdigest())
    except FileNotFoundError:
        if 'D' not in xy: item['limitation'] = 'File disappeared during observation'
        item['missing'] = True
    except OSError as e: item['limitation'] = 'Unreadable content: '+str(e)
    if item.get('limitation'): limitations.append(path+': '+item['limitation'])
    inventory.append(item)
# Include the complete patches, index entries and every new file's digest in the observation, without storing a filesystem snapshot.
h = hashlib.sha256()
for data in [status, git('ls-files', '--stage', '-z').stdout, *patches, json.dumps(inventory, sort_keys=True).encode()]: h.update(data)
if git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all').stdout != status or git('rev-parse', '--verify', 'HEAD', required=False).stdout != head_r.stdout:
    limitations.append('The checkout changed during observation')
print(json.dumps({'root': os.path.realpath(root), 'gitdir': git('rev-parse', '--absolute-git-dir').stdout.decode().strip(), 'task': p.get('task'), 'mode': mode, 'ref': label, 'resolvedRef': resolved, 'base': base, 'head': head, 'inventory': inventory, 'digest': h.hexdigest(), 'limitations': limitations}))
`;

export async function capture(io, target) {
  const r = await io.exec("python3", ["-c", CAPTURE, JSON.stringify(target)]);
  if (r.code !== 0) throw new Error((r.stderr || "Cannot resolve the review target").trim().split("\n").pop());
  return JSON.parse(r.stdout);
}

export const targetKey = (t) => JSON.stringify([t.cwd, t.on ?? null, t.task ?? null, t.base ?? null, t.mode, t.ref ?? "", !!t.pending, !!t.retained, t.workspace ?? null]);
