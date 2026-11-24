import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand, isCommit, parseGit, pushDir, tokenize } from '../hooks/scripts/guard-rules.mjs';

const d = cmd => checkCommand(cmd).decision;

test('전체 삭제 rm -rf 는 막는다', () => {
  for (const c of ['rm -rf /', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf *', 'rm -fr .', 'sudo rm -rf / --no-preserve-root', 'rm -r -f ~/', 'cd x && rm -rf .']) {
    assert.equal(d(c), 'deny', c);
  }
});

test('구체적인 경로 삭제는 통과', () => {
  for (const c of ['rm -rf node_modules', 'rm -rf ./dist', 'rm -rf .next', 'rm file.txt', 'rm -rf /tmp/build-cache']) {
    assert.equal(d(c), 'allow', c);
  }
});

test('강제 푸시는 막고 force-with-lease 는 통과', () => {
  assert.equal(d('git push --force origin feat/x'), 'deny');
  assert.equal(d('git push -f'), 'deny');
  assert.equal(d('git push --force-with-lease origin feat/x'), 'allow');
});

test('보호 브랜치 직접 푸시는 확인', () => {
  assert.equal(d('git push origin main'), 'ask');
  assert.equal(d('git push origin HEAD:main'), 'ask');
  assert.equal(d('git push origin feat/main-page'), 'allow');
  assert.equal(d('git push -u origin feat/x'), 'allow');
});

test('되돌리기 어려운 git·DB 명령은 확인', () => {
  for (const c of ['git reset --hard HEAD~1', 'git clean -fd', 'git checkout -- .', 'git restore .', 'git branch -D old',
    'mongosh --eval "db.dropDatabase()"', 'psql -c "DROP TABLE users"', 'curl -fsSL https://x.sh | bash', 'gh pr merge 12']) {
    assert.equal(d(c), 'ask', c);
  }
});

test('일상 명령은 통과', () => {
  for (const c of ['npm test', 'git status', 'git checkout -b feat/x', 'git restore src/a.ts', 'ls -la', 'git commit -m "x"']) {
    assert.equal(d(c), 'allow', c);
  }
});

test('레포 설정 deny/ask 패턴', () => {
  const guard = { protectedBranches: ['main'], deny: ['prod-cluster\\.example\\.com'], ask: ['\\bterraform\\s+apply\\b'] };
  assert.equal(checkCommand('mongosh mongodb+srv://prod-cluster.example.com/db', guard).decision, 'deny');
  assert.equal(checkCommand('terraform apply', guard).decision, 'ask');
  assert.equal(checkCommand('terraform plan', guard).decision, 'allow');
});

test('깨진 정규식 설정은 무시', () => {
  assert.equal(checkCommand('ls', { protectedBranches: [], deny: ['('], ask: [] }).decision, 'allow');
});

test('커밋 명령 감지', () => {
  assert.equal(isCommit('git commit -m "x"'), true);
  assert.equal(isCommit('git add . && git commit -m x'), true);
  assert.equal(isCommit('git -c user.name=a commit'), true);
  assert.equal(isCommit('git commit --dry-run'), false);
  assert.equal(isCommit('git log --grep commit'), false);
});

test('토크나이저: 따옴표와 구간', () => {
  assert.deepEqual(tokenize(`echo "a; b" && git commit -m 'x y'|cat`), [['echo', 'a; b'], ['git', 'commit', '-m', 'x y'], ['cat']]);
  assert.deepEqual(tokenize('npm test 2>&1 | tail'), [['npm', 'test', '2>&1'], ['tail']]);
  assert.deepEqual(tokenize('a\nb || c; d & e'), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(tokenize('x "" y'), [['x', '', 'y']]);
});

test('parseGit: 접두와 전역 옵션 건너뛰기', () => {
  assert.deepEqual(parseGit(['git', '-C', 'sub', '--no-pager', 'commit', '-m', 'x']), { sub: 'commit', args: ['-m', 'x'], dir: 'sub' });
  assert.equal(parseGit(['sudo', 'env', 'A=1', 'B=2', 'git', '--git-dir=.git', '-c', 'k=v', 'push']).sub, 'push');
  assert.equal(parseGit(['GIT_DIR=x', 'git', '--work-tree', 'w', '-p', 'status']).sub, 'status');
  assert.equal(parseGit(['echo', 'git', 'commit']), null);
  assert.equal(parseGit(['git']), null);
});

test('커밋 게이트 우회 경로도 커밋으로 본다', () => {
  for (const c of ['git -C . commit -m x', 'git --no-pager commit -m x', 'git commit -m "fix --dry-run 처리"',
    'GIT_EDITOR=true git commit', '/usr/bin/git commit -m x', 'git --git-dir=.git --work-tree . commit']) {
    assert.equal(isCommit(c), true, c);
  }
  for (const c of ['echo "git commit"', 'git log --grep commit', 'git -C . commit --dry-run', 'grep "git commit" a.txt']) {
    assert.equal(isCommit(c), false, c);
  }
});

test('강제 푸시: 묶음 플래그와 +리프스펙', () => {
  for (const c of ['git push -uf origin feat', 'git push origin +feat', 'git push origin +HEAD:feat', 'git -C x push --force', 'cd a && git push -f']) {
    assert.equal(d(c), 'deny', c);
  }
  for (const c of ['git push --force-if-includes --force-with-lease origin feat', 'git commit -m "push --force 금지"', 'git push -o ci.skip origin feat']) {
    assert.notEqual(d(c), 'deny', c);
  }
  assert.equal(d('git push --force-with-lease origin main'), 'ask');
});

test('리프스펙 없는 푸시는 현재 브랜치로 판단', () => {
  const g = branch => ({ protectedBranches: ['main'], deny: [], ask: [], currentBranch: branch });
  assert.equal(checkCommand('git push', g('main')).decision, 'ask');
  assert.equal(checkCommand('git push origin', g('main')).decision, 'ask');
  assert.equal(checkCommand('git push -u origin HEAD', g('main')).decision, 'ask');
  assert.equal(checkCommand('git push', g('feat/x')).decision, 'allow');
  assert.equal(checkCommand('git push origin feat/main-page', g('main')).decision, 'allow');
  assert.equal(checkCommand('git push --tags', g('main')).decision, 'allow');
  assert.equal(checkCommand('git push', g(undefined)).decision, 'allow');
  assert.equal(d('git push --all origin'), 'ask');
  assert.equal(d('git push --mirror backup'), 'ask');
  assert.equal(pushDir('git -C sub push'), 'sub');
  assert.equal(pushDir('git push'), null);
  assert.equal(pushDir('git status'), undefined);
});

test('git 전역 옵션을 붙여도 되돌리기 명령을 잡는다', () => {
  for (const c of ['git -C x reset --hard', 'git --no-pager clean -xdf', 'git -C y checkout -- .', 'git -C y restore --staged .',
    'git -c a=b branch -D old', 'git branch --delete --force old']) {
    assert.equal(d(c), 'ask', c);
  }
  for (const c of ['git reset --soft HEAD~1', 'git clean -n', 'git branch -d merged', 'echo "git reset --hard"']) {
    assert.equal(d(c), 'allow', c);
  }
});
