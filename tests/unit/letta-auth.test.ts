/**
 * Unit Tests: Letta Auth Resolution
 *
 * Tests the auth resolution chain for letta-sync:
 * 1. LETTA_SERVER_PASSWORD for self-hosted (non-cloud)
 * 2. LETTA_SYNC_AUTH_HELPER external command
 * 3. LETTA_API_KEY environment variable
 * 4. ~/.letta/settings.json
 *
 * @see tools/letta-sync/src/config/letta-auth.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

// We need to mock before importing the module
vi.mock('node:fs');
vi.mock('node:child_process');

// Import after mocking
import {
  resolveLettaApiKey,
  getLettaBaseUrl,
  isTargetingLettaCloud,
} from '../../src/config/letta-auth.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const MOCK_SETTINGS_PATH = path.join(os.homedir(), '.letta', 'settings.json');
const CLOUD_API_KEY = 'cloud-api-key-123';
const ENV_API_KEY = 'env-api-key-456';
const HELPER_TOKEN = 'helper-token-789';
const SERVER_PASSWORD = 'server-password-abc';

function mockSettingsFile(content: object | null): void {
  const mockedFs = vi.mocked(fs);
  if (content === null) {
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
  } else {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(content));
  }
}

function mockAuthHelper(output: string | Error): void {
  const mockedCp = vi.mocked(childProcess);
  if (output instanceof Error) {
    mockedCp.execFileSync.mockImplementation(() => {
      throw output;
    });
  } else {
    mockedCp.execFileSync.mockReturnValue(output);
  }
}

// =============================================================================
// Test Setup
// =============================================================================

describe('letta-auth', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars
    delete process.env.LETTA_BASE_URL;
    delete process.env.LETTA_API_URL;
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_SERVER_PASSWORD;
    delete process.env.LETTA_SYNC_AUTH_HELPER;
    delete process.env.LETTA_SYNC_AUTH_HELPER_ARGS;
    delete process.env.DEBUG;
    delete process.env.LETTA_SYNC_DEBUG;

    // Default: settings file doesn't exist
    mockSettingsFile(null);
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  // ===========================================================================
  // getLettaBaseUrl Tests
  // ===========================================================================

  describe('getLettaBaseUrl', () => {
    it('should return LETTA_BASE_URL if set', () => {
      process.env.LETTA_BASE_URL = 'https://custom.letta.io';

      expect(getLettaBaseUrl()).toBe('https://custom.letta.io');
    });

    it('should return LETTA_API_URL if LETTA_BASE_URL not set', () => {
      process.env.LETTA_API_URL = 'https://api.custom.com';

      expect(getLettaBaseUrl()).toBe('https://api.custom.com');
    });

    it('should prefer LETTA_BASE_URL over LETTA_API_URL', () => {
      process.env.LETTA_BASE_URL = 'https://primary.letta.io';
      process.env.LETTA_API_URL = 'https://fallback.letta.io';

      expect(getLettaBaseUrl()).toBe('https://primary.letta.io');
    });

    it('should default to Letta Cloud if no env vars set', () => {
      expect(getLettaBaseUrl()).toBe('https://api.letta.com');
    });
  });

  // ===========================================================================
  // isTargetingLettaCloud Tests
  // ===========================================================================

  describe('isTargetingLettaCloud', () => {
    it('should return true for default (Cloud)', () => {
      expect(isTargetingLettaCloud()).toBe(true);
    });

    it('should return true for explicit Cloud URL', () => {
      process.env.LETTA_BASE_URL = 'https://api.letta.com';

      expect(isTargetingLettaCloud()).toBe(true);
    });

    it('should return false for self-hosted URL', () => {
      process.env.LETTA_BASE_URL = 'https://letta.mycompany.com';

      expect(isTargetingLettaCloud()).toBe(false);
    });

    it('should return false for localhost', () => {
      process.env.LETTA_BASE_URL = 'http://localhost:8283';

      expect(isTargetingLettaCloud()).toBe(false);
    });
  });

  // ===========================================================================
  // resolveLettaApiKey Tests - Self-hosted
  // ===========================================================================

  describe('resolveLettaApiKey (self-hosted)', () => {
    beforeEach(() => {
      // Configure as self-hosted
      process.env.LETTA_BASE_URL = 'http://localhost:8283';
    });

    it('should use LETTA_SERVER_PASSWORD for self-hosted', () => {
      process.env.LETTA_SERVER_PASSWORD = SERVER_PASSWORD;

      expect(resolveLettaApiKey()).toBe(SERVER_PASSWORD);
    });

    it('should trim LETTA_SERVER_PASSWORD', () => {
      process.env.LETTA_SERVER_PASSWORD = `  ${SERVER_PASSWORD}  `;

      expect(resolveLettaApiKey()).toBe(SERVER_PASSWORD);
    });

    it('should fall through to LETTA_API_KEY if LETTA_SERVER_PASSWORD not set', () => {
      process.env.LETTA_API_KEY = ENV_API_KEY;

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });

    it('should ignore empty LETTA_SERVER_PASSWORD', () => {
      process.env.LETTA_SERVER_PASSWORD = '   ';
      process.env.LETTA_API_KEY = ENV_API_KEY;

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });
  });

  // ===========================================================================
  // resolveLettaApiKey Tests - Auth Helper
  // ===========================================================================

  describe('resolveLettaApiKey (auth helper)', () => {
    it('should use auth helper output when configured', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      mockAuthHelper(HELPER_TOKEN);

      expect(resolveLettaApiKey()).toBe(HELPER_TOKEN);

      const mockedCp = vi.mocked(childProcess);
      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        '/usr/bin/get-token',
        [],
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('should trim auth helper output', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      mockAuthHelper(`  ${HELPER_TOKEN}\n`);

      expect(resolveLettaApiKey()).toBe(HELPER_TOKEN);
    });

    it('should pass whitespace-separated args to auth helper', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      process.env.LETTA_SYNC_AUTH_HELPER_ARGS = 'arg1 arg2 arg3';
      mockAuthHelper(HELPER_TOKEN);

      resolveLettaApiKey();

      const mockedCp = vi.mocked(childProcess);
      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        '/usr/bin/get-token',
        ['arg1', 'arg2', 'arg3'],
        expect.anything()
      );
    });

    it('should pass JSON array args to auth helper', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      process.env.LETTA_SYNC_AUTH_HELPER_ARGS = '["--vault", "prod", "--ttl", "3600"]';
      mockAuthHelper(HELPER_TOKEN);

      resolveLettaApiKey();

      const mockedCp = vi.mocked(childProcess);
      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        '/usr/bin/get-token',
        ['--vault', 'prod', '--ttl', '3600'],
        expect.anything()
      );
    });

    it('should fall back to LETTA_API_KEY if auth helper fails', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      process.env.LETTA_API_KEY = ENV_API_KEY;
      mockAuthHelper(new Error('Command not found'));

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });

    it('should fall back to LETTA_API_KEY if auth helper returns empty', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      process.env.LETTA_API_KEY = ENV_API_KEY;
      mockAuthHelper('   ');

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });

    it('should not call helper if LETTA_SYNC_AUTH_HELPER is empty', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '';
      process.env.LETTA_API_KEY = ENV_API_KEY;

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);

      const mockedCp = vi.mocked(childProcess);
      expect(mockedCp.execFileSync).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // resolveLettaApiKey Tests - Environment Variable
  // ===========================================================================

  describe('resolveLettaApiKey (env var)', () => {
    it('should use LETTA_API_KEY environment variable', () => {
      process.env.LETTA_API_KEY = ENV_API_KEY;

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });

    it('should trim LETTA_API_KEY', () => {
      process.env.LETTA_API_KEY = `  ${ENV_API_KEY}  `;

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });

    it('should ignore empty LETTA_API_KEY', () => {
      process.env.LETTA_API_KEY = '   ';
      mockSettingsFile({ env: { LETTA_API_KEY: CLOUD_API_KEY } });

      expect(resolveLettaApiKey()).toBe(CLOUD_API_KEY);
    });
  });

  // ===========================================================================
  // resolveLettaApiKey Tests - Settings File
  // ===========================================================================

  describe('resolveLettaApiKey (settings file)', () => {
    it('should read from ~/.letta/settings.json', () => {
      mockSettingsFile({ env: { LETTA_API_KEY: CLOUD_API_KEY } });

      expect(resolveLettaApiKey()).toBe(CLOUD_API_KEY);

      const mockedFs = vi.mocked(fs);
      expect(mockedFs.readFileSync).toHaveBeenCalledWith(MOCK_SETTINGS_PATH, 'utf-8');
    });

    it('should trim settings file API key', () => {
      mockSettingsFile({ env: { LETTA_API_KEY: `  ${CLOUD_API_KEY}  ` } });

      expect(resolveLettaApiKey()).toBe(CLOUD_API_KEY);
    });

    it('should return null if settings file missing', () => {
      mockSettingsFile(null);

      expect(resolveLettaApiKey()).toBeNull();
    });

    it('should return null if settings file has no env section', () => {
      mockSettingsFile({ other: 'data' });

      expect(resolveLettaApiKey()).toBeNull();
    });

    it('should return null if settings file has empty LETTA_API_KEY', () => {
      mockSettingsFile({ env: { LETTA_API_KEY: '   ' } });

      expect(resolveLettaApiKey()).toBeNull();
    });

    it('should return null if LETTA_API_KEY is not a string', () => {
      mockSettingsFile({ env: { LETTA_API_KEY: 12345 } });

      expect(resolveLettaApiKey()).toBeNull();
    });
  });

  // ===========================================================================
  // resolveLettaApiKey Tests - Precedence
  // ===========================================================================

  describe('resolveLettaApiKey (precedence)', () => {
    it('should prefer auth helper over LETTA_API_KEY', () => {
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      process.env.LETTA_API_KEY = ENV_API_KEY;
      mockAuthHelper(HELPER_TOKEN);

      expect(resolveLettaApiKey()).toBe(HELPER_TOKEN);
    });

    it('should prefer LETTA_API_KEY over settings file', () => {
      process.env.LETTA_API_KEY = ENV_API_KEY;
      mockSettingsFile({ env: { LETTA_API_KEY: CLOUD_API_KEY } });

      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });

    it('should prefer LETTA_SERVER_PASSWORD over all for self-hosted', () => {
      process.env.LETTA_BASE_URL = 'http://localhost:8283';
      process.env.LETTA_SERVER_PASSWORD = SERVER_PASSWORD;
      process.env.LETTA_SYNC_AUTH_HELPER = '/usr/bin/get-token';
      process.env.LETTA_API_KEY = ENV_API_KEY;
      mockAuthHelper(HELPER_TOKEN);
      mockSettingsFile({ env: { LETTA_API_KEY: CLOUD_API_KEY } });

      expect(resolveLettaApiKey()).toBe(SERVER_PASSWORD);
    });

    it('should NOT use LETTA_SERVER_PASSWORD for Cloud', () => {
      // Default is Cloud
      process.env.LETTA_SERVER_PASSWORD = SERVER_PASSWORD;
      process.env.LETTA_API_KEY = ENV_API_KEY;

      // Should use LETTA_API_KEY, not LETTA_SERVER_PASSWORD
      expect(resolveLettaApiKey()).toBe(ENV_API_KEY);
    });
  });

  // ===========================================================================
  // resolveLettaApiKey Tests - No Credentials
  // ===========================================================================

  describe('resolveLettaApiKey (no credentials)', () => {
    it('should return null when no credentials available', () => {
      mockSettingsFile(null);

      expect(resolveLettaApiKey()).toBeNull();
    });
  });
});
