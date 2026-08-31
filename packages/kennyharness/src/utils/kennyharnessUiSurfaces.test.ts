import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

import { isInGlobalClaudeFolder } from '../components/permissions/FilePermissionDialog/permissionOptions.tsx'
import { optionForPermissionSaveDestination } from '../components/permissions/rules/AddPermissionRules.tsx'
import { getDefaultPermissionModeOptions } from './permissions/defaultPermissionModeOptions.ts'
import {
  getClaudeSkillScope,
  isClaudeSettingsPath,
} from './permissions/filesystem.ts'
import { getValidationTip } from './settings/validationTips.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  await acquireSharedMutationLock('kennyharnessUiSurfaces.test.ts')
})

afterEach(() => {
  try {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('KennyHarness settings path surfaces', () => {
  test('isClaudeSettingsPath recognizes project .kennyharness settings files', () => {
    expect(
      isClaudeSettingsPath(
        join(process.cwd(), '.kennyharness', 'settings.json'),
      ),
    ).toBe(true)

    expect(
      isClaudeSettingsPath(
        join(process.cwd(), '.kennyharness', 'settings.local.json'),
      ),
    ).toBe(true)
  })

  test('permission save destinations point user settings to ~/.kennyharness', () => {
    expect(optionForPermissionSaveDestination('userSettings')).toEqual({
      label: 'User settings',
      description: 'Saved in ~/.kennyharness/settings.json',
      value: 'userSettings',
    })
  })

  test('permission save destinations point project settings to .kennyharness', () => {
    expect(optionForPermissionSaveDestination('projectSettings')).toEqual({
      label: 'Project settings',
      description: 'Checked in at .kennyharness/settings.json',
      value: 'projectSettings',
    })

    expect(optionForPermissionSaveDestination('localSettings')).toEqual({
      label: 'Project settings (local)',
      description: 'Saved in .kennyharness/settings.local.json',
      value: 'localSettings',
    })
  })

  test('permission dialog treats ~/.kennyharness as the global KennyHarness folder', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.kennyharness')

    expect(
      isInGlobalClaudeFolder(
        join(homedir(), '.kennyharness', 'settings.json'),
      ),
    ).toBe(true)
    expect(
      isInGlobalClaudeFolder(join(homedir(), '.claude', 'settings.json')),
    ).toBe(true)
  })

  test('permission dialog does not treat arbitrary CLAUDE_CONFIG_DIR as the global KennyHarness folder', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), 'custom-kennyharness')

    expect(
      isInGlobalClaudeFolder(
        join(homedir(), 'custom-kennyharness', 'settings.json'),
      ),
    ).toBe(false)
  })

  test('global skill scope recognizes ~/.kennyharness and legacy ~/.claude skills', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.kennyharness')

    expect(
      getClaudeSkillScope(
        join(homedir(), '.kennyharness', 'skills', 'demo', 'SKILL.md'),
      ),
    ).toEqual({
      skillName: 'demo',
      pattern: '~/.kennyharness/skills/demo/**',
    })

    expect(
      getClaudeSkillScope(
        join(homedir(), '.claude', 'skills', 'legacy', 'SKILL.md'),
      ),
    ).toEqual({
      skillName: 'legacy',
      pattern: '~/.claude/skills/legacy/**',
    })
  })

  test('global skill scope does not emit fixed rules for arbitrary CLAUDE_CONFIG_DIR skills', () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), 'custom-kennyharness')

    expect(
      getClaudeSkillScope(
        join(homedir(), 'custom-kennyharness', 'skills', 'demo', 'SKILL.md'),
      ),
    ).toBe(null)
  })
})

describe('KennyHarness validation tips', () => {
  test('permissions.defaultMode invalid value keeps suggestion but no docs link', () => {
    const tip = getValidationTip({
      path: 'permissions.defaultMode',
      code: 'invalid_value',
      enumValues: [
        'acceptEdits',
        'bypassPermissions',
        'default',
        'dontAsk',
        'fullAccess',
        'plan',
      ],
    })

    expect(tip).toEqual({
      suggestion:
        'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only), "bypassPermissions" (auto-accept prompts), "fullAccess" (skip even hard safety-check prompts), or "default" (standard behavior)',
    })
  })
})

describe('KennyHarness permission mode surfaces', () => {
  test('default permission mode picker excludes dangerous persisted modes', () => {
    const options = getDefaultPermissionModeOptions(true)

    expect(options).not.toContain('bypassPermissions')
    expect(options).not.toContain('fullAccess')
  })
})
