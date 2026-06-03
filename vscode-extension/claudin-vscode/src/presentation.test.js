const test = require('node:test');
const assert = require('node:assert/strict');

function loadPresentation() {
  return require('./presentation');
}

test('truncateMiddle keeps the profile filename visible', () => {
  const { truncateMiddle } = loadPresentation();

  assert.equal(
    truncateMiddle('/Users/example/projects/claudin/workspace/.claudin-profile.json', 30),
    '.../.claudin-profile.json',
  );
});

test('truncateMiddle keeps the filename visible for Windows-style paths', () => {
  const { truncateMiddle } = loadPresentation();

  assert.equal(
    truncateMiddle('C:\\Users\\example\\claudin\\workspace\\.claudin-profile.json', 30),
    '...\\.claudin-profile.json',
  );
});

test('buildActionModel disables workspace-root launch without a workspace', () => {
  const { buildActionModel } = loadPresentation();

  const model = buildActionModel({
    canLaunchInWorkspaceRoot: false,
    workspaceProfilePath: null,
  });

  assert.deepEqual(model.launchRoot, {
    id: 'launchRoot',
    label: 'Launch in Workspace Root',
    detail: 'Open a workspace folder to enable workspace-root launch',
    tone: 'neutral',
    disabled: true,
  });
});

test('buildActionModel hides workspace-profile action when no profile exists', () => {
  const { buildActionModel } = loadPresentation();

  const model = buildActionModel({
    canLaunchInWorkspaceRoot: true,
    workspaceProfilePath: null,
  });

  assert.deepEqual(model.primary, {
    id: 'launch',
    label: 'Launch Claudin',
    detail: 'Use the resolved project-aware launch directory',
    tone: 'accent',
    disabled: false,
  });
  assert.equal(model.openProfile, null);
});

test('buildActionModel includes workspace-profile action when a profile exists', () => {
  const { buildActionModel } = loadPresentation();

  const model = buildActionModel({
    canLaunchInWorkspaceRoot: true,
    workspaceProfilePath: 'C:\\Users\\example\\claudin\\workspace\\.claudin-profile.json',
  });

  assert.deepEqual(model.openProfile, {
    id: 'openProfile',
    label: 'Open Workspace Profile',
    detail: 'Inspect ...\\.claudin-profile.json',
    tone: 'neutral',
    disabled: false,
  });
});

function createStatus(overrides = {}) {
  return {
    installed: true,
    executable: 'claudin',
    launchCommand: 'claudin --project-aware',
    terminalName: 'Claudin',
    shimEnabled: false,
    workspaceFolder: '/workspace/claudin',
    workspaceSourceLabel: 'active editor workspace',
    launchCwd: '/workspace/claudin',
    launchCwdLabel: '/workspace/claudin',
    canLaunchInWorkspaceRoot: true,
    profileStatusLabel: 'Found',
    profileStatusHint: '/workspace/claudin/.claudin-profile.json',
    workspaceProfilePath: '/workspace/claudin/.claudin-profile.json',
    providerState: {
      label: 'Codex',
      detail: 'gpt-5.4',
      source: 'profile',
    },
    providerSourceLabel: 'saved profile',
    ...overrides,
  };
}

test('buildControlCenterViewModel keeps header badges and summary cards non-redundant', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus());
  const headerKeys = new Set(viewModel.headerBadges.map(badge => badge.key));
  const summaryKeys = new Set(viewModel.summaryCards.map(card => card.key));

  assert.deepEqual([...headerKeys].sort(), ['profileStatus', 'provider', 'runtime']);
  assert.deepEqual([...summaryKeys].sort(), ['launchCommand', 'launchCwd', 'workspace']);

  for (const key of headerKeys) {
    assert.equal(summaryKeys.has(key), false);
  }
});

test('buildControlCenterViewModel uses stable semantic tones for badges and actions', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus({
    installed: false,
    profileStatusLabel: 'Invalid',
    providerState: {
      label: 'OpenAI-compatible (provider unknown)',
      detail: 'launch shim enabled',
      source: 'shim',
    },
    providerSourceLabel: 'launch setting',
  }));

  assert.deepEqual(viewModel.headerBadges, [
    {
      key: 'runtime',
      label: 'Runtime',
      value: 'Missing',
      tone: 'critical',
    },
    {
      key: 'provider',
      label: 'Provider',
      value: 'OpenAI-compatible (provider unknown)',
      tone: 'warning',
    },
    {
      key: 'profileStatus',
      label: 'Profile',
      value: 'Invalid',
      tone: 'warning',
    },
  ]);

  assert.equal(viewModel.actions.primary.tone, 'accent');
  assert.equal(viewModel.actions.launchRoot.tone, 'neutral');
});

test('buildControlCenterViewModel uses a concise project summary before full path detail', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus());

  assert.deepEqual(viewModel.detailSections, [
    {
      title: 'Project',
      rows: [
        {
          key: 'workspace',
          label: 'Workspace folder',
          summary: 'claudin',
          detail: '/workspace/claudin · active editor workspace',
        },
        {
          key: 'profileStatus',
          label: 'Workspace profile',
          summary: 'Found',
          detail: '/workspace/claudin/.claudin-profile.json',
          tone: 'neutral',
        },
      ],
    },
    {
      title: 'Runtime',
      rows: [
        {
          key: 'runtime',
          label: 'Claudin executable',
          summary: 'Installed',
          detail: 'claudin',
          tone: 'positive',
        },
        {
          key: 'provider',
          label: 'Detected provider',
          summary: 'Codex',
          detail: 'gpt-5.4 · saved profile',
          tone: 'neutral',
        },
      ],
    },
  ]);
});

test('buildControlCenterViewModel keeps launch command only in summary cards', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus());

  assert.deepEqual(viewModel.summaryCards.find(card => card.key === 'launchCommand'), {
    key: 'launchCommand',
    label: 'Launch command',
    value: 'claudin --project-aware',
    detail: 'Integrated terminal: Claudin',
  });

  assert.equal(
    viewModel.detailSections.some(section => section.rows.some(row => row.key === 'launchCommand')),
    false,
  );
});

test('buildControlCenterViewModel keeps env-backed provider detail non-redundant', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus({
    providerState: {
      label: 'Gemini',
      detail: 'from environment',
      source: 'env',
    },
    providerSourceLabel: 'environment',
  }));

  assert.deepEqual(viewModel.detailSections[1].rows.find(row => row.key === 'provider'), {
    key: 'provider',
    label: 'Detected provider',
    summary: 'Gemini',
    detail: 'from environment',
    tone: 'neutral',
  });
});

test('buildControlCenterViewModel keeps shim-backed provider detail honest', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus({
    providerState: {
      label: 'OpenAI-compatible (provider unknown)',
      detail: 'launch shim enabled',
      source: 'shim',
    },
    providerSourceLabel: 'launch setting',
  }));

  assert.deepEqual(viewModel.detailSections[1].rows.find(row => row.key === 'provider'), {
    key: 'provider',
    label: 'Detected provider',
    summary: 'OpenAI-compatible (provider unknown)',
    detail: 'launch shim enabled',
    tone: 'warning',
  });
});

test('buildControlCenterViewModel keeps unknown provider detail honest', () => {
  const { buildControlCenterViewModel } = loadPresentation();

  const viewModel = buildControlCenterViewModel(createStatus({
    providerState: {
      label: 'Unknown',
      detail: 'no saved profile or provider env detected',
      source: 'unknown',
    },
    providerSourceLabel: 'unknown',
  }));

  assert.deepEqual(viewModel.detailSections[1].rows.find(row => row.key === 'provider'), {
    key: 'provider',
    label: 'Detected provider',
    summary: 'Unknown',
    detail: 'no saved profile or provider env detected',
    tone: 'warning',
  });
});

test('buildControlCenterViewModel carries forward the existing action model', () => {
  const { buildControlCenterViewModel, buildActionModel } = loadPresentation();

  const status = createStatus();
  const viewModel = buildControlCenterViewModel(status);

  assert.deepEqual(viewModel.actions, buildActionModel(status));
});
