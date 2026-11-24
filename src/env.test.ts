// Reading and editing .env files, and what a dbt profile needs from the environment.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { deleteDotenvVar, envSources, parseDotenv, requiredEnvVars, setDotenvVar } from './env'

test('reads .env files as dotenv does', () => {
  assert.deepEqual(
    parseDotenv('# comment\nexport WAREHOUSE=acme\nTARGET_ENV="dev" \nROLE=\'analyst\'\nEMPTY=\nNOTE=a b # trailing'),
    { WAREHOUSE: 'acme', TARGET_ENV: 'dev', ROLE: 'analyst', EMPTY: '', NOTE: 'a b' }
  )
})

test('edits a .env in place, keeping comments, order and export', () => {
  const original = '# Snowflake\nexport ACCOUNT=acme\nROLE=analyst\n\n# Other\nTOKEN=old\n'
  let text = setDotenvVar(original, 'ROLE', 'engineer')
  text = setDotenvVar(text, 'ACCOUNT', 'acme-eu')
  text = setDotenvVar(text, 'NEW_ONE', 'x')
  assert.equal(text, '# Snowflake\nexport ACCOUNT=acme-eu\nROLE=engineer\n\n# Other\nTOKEN=old\nNEW_ONE=x\n')
  assert.equal(deleteDotenvVar(text, 'TOKEN'), '# Snowflake\nexport ACCOUNT=acme-eu\nROLE=engineer\n\n# Other\nNEW_ONE=x\n')
  assert.equal(setDotenvVar('', 'FIRST', '1'), 'FIRST=1\n')
})

test('quotes values so they read back unchanged', () => {
  for (const value of ['plain', 'has space', 'a#b', "it's", 'say "hi"', 'two\nlines', '', 'p@ss:w0rd/+=']) {
    assert.equal(parseDotenv(setDotenvVar('', 'KEY', value)).KEY, value, value)
  }
})

test('finds the env files and what the profile needs', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-dbt-env-'))
  try {
    const project = join(root, 'data-platform', 'dbt')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(root, '.env'), 'A=1\n')
    writeFileSync(join(root, 'data-platform', '.env'), 'B=2\n')
    writeFileSync(join(project, 'dbt_project.yml'), "name: shop\nprofile: 'shop'\nvars:\n  run: \"{{ env_var('RUN_ID', 'local') }}\"\n")
    // Two profiles: only the project's own block counts.
    writeFileSync(
      join(project, 'profiles.yml'),
      [
        'other:',
        "  outputs: { dev: { password: \"{{ env_var('OTHER_SECRET') }}\" } }",
        'shop:',
        '  target: dev',
        '  outputs:',
        '    dev:',
        "      account: \"{{ env_var('ACCOUNT_NAME') }}\"",
        "      role: \"{{ env_var('SNOWFLAKE_ROLE', '') }}\"",
        ''
      ].join('\n')
    )

    // Every .env from the root down; Save writes the deepest.
    assert.deepEqual(envSources(root, project, ''), {
      files: [join(root, '.env'), join(root, 'data-platform', '.env')],
      target: join(root, 'data-platform', '.env')
    })
    // A chosen file is read alone, and written even before it exists.
    assert.deepEqual(envSources(root, project, 'secrets/prod.env'), { files: [], target: join(root, 'secrets', 'prod.env') })

    assert.deepEqual(requiredEnvVars(project, {}), {
      profile: 'shop',
      profilesFile: join(project, 'profiles.yml'),
      vars: [
        { key: 'ACCOUNT_NAME', hasDefault: false },
        { key: 'RUN_ID', hasDefault: true },
        { key: 'SNOWFLAKE_ROLE', hasDefault: true }
      ]
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
