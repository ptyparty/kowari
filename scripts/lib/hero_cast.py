import os
import shutil
import subprocess
import sys

import hero_sandbox as hs

ROOT = '/tmp/demo-db'
SESSION = 'hero'
COLS, ROWS = 160, 46
DOWN, TAB, F5, ESC = '\x1b[B', '\t', '\x1b[15~', '\x1b'
ALT_C, ALT_J = '\x1bc', '\x1bj'

QUESTION = "Cascade's webhooks keep failing. What's going on? Check the local db."

REPO_CONNECTIONS = '''[connections.local]
host = "localhost"
port = "%s"
database = "shop"
user = "shop"
password = "shop"
'''

USER_CONNECTIONS = '''[connections.staging]
host = "shop-staging.internal"
database = "shop"
user = "reader"
agent = "read-only"

[repos."github.com/example/shop"]
local = "approve-writes"
'''

QMUX_CONFIG = '''export default {
  defaultCwd: %(worktree)s,
  untrackedCommands: ["claude", "remax", "hx", "qmux", "quoll", "kowari"],
  tabs: { shop: { cwd: %(worktree)s, layout: "db" } },
  startup: ["shop"],
  layouts: {
    db: {
      jobs: [{ name: "claude", command: ["qmux", "claude", "--mode", "auto"], dock: true }],
      row: [{ command: ["kowari"], focus: true }],
    },
  },
};
'''


def prepare(repo, port):
    shutil.rmtree(ROOT, ignore_errors=True)
    ptyparty = hs.ptyparty_dir(repo)
    sandbox, env = hs.environment(ROOT, ptyparty)
    worktree = os.path.join(ROOT, 'shop')
    os.makedirs(worktree)
    subprocess.run(['git', 'init', '-q', worktree], check=True)
    subprocess.run(
        ['git', '-C', worktree, 'remote', 'add', 'origin', 'git@github.com:example/shop.git'],
        check=True,
    )
    with open(os.path.join(worktree, '.kowari.toml'), 'w') as handle:
        handle.write(REPO_CONNECTIONS % port)
    kowari_config = os.path.join(env['XDG_CONFIG_HOME'], 'kowari')
    os.makedirs(kowari_config)
    with open(os.path.join(kowari_config, 'connections.toml'), 'w') as handle:
        handle.write(USER_CONNECTIONS)
    hs.write_qmux_config(env, QMUX_CONFIG, worktree=worktree)
    hs.claude_config(sandbox, worktree, [os.path.join(repo, 'skills', 'kowari')], env, deny=hs.KEYRING_DENIES)
    return worktree, env


def tour(cast):
    cast.wait_for('Connections', budget=40)
    cast.hold(1.5)
    cast.press(DOWN, gap=0.8)
    cast.press('\r', gap=0.3)
    cast.wait_for('Tables', budget=20, record=True)
    cast.hold(1.2)
    cast.keys('i', per_key=0.2)
    cast.keys('select * from web', per_key=0.06)
    cast.hold(1.0)
    cast.press(TAB, gap=0.9)
    cast.keys('a', per_key=0.3)
    cast.press(TAB, gap=0.9)
    cast.press(F5, gap=1.8)
    cast.press(TAB, gap=0.8)
    cast.keys('j', per_key=0.5)
    cast.keys('lllll', per_key=0.35)
    cast.hold(0.6)
    cast.press('\r', gap=3.5)
    cast.press(ESC, gap=1.0)
    cast.press(ALT_C, gap=0.3)
    cast.wait_for('Message claude', budget=20, record=True)
    cast.hold(0.5)
    cast.keys(QUESTION, per_key=0.02)
    cast.hold(0.6)
    cast.press('\r', gap=1.0)
    if not cast.lapse_until(lambda t: '🚀' in hs.dock(t), budget=400):
        return False
    cast.hold(2.5)
    cast.press(ALT_J, gap=7)
    cast.press(ALT_J, gap=1.5)
    return True


def main():
    out_base, port = sys.argv[1], sys.argv[2]
    repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    worktree, env = prepare(repo, port)
    hs.record(['qmux', 'attach', SESSION], COLS, ROWS, worktree, env, SESSION, tour, out_base)


if __name__ == '__main__':
    main()
