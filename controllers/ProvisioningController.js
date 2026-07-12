import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

const packages = {
  ansible: 'ansible',
  vagrant: 'vagrant',
  'isc-dhcp': 'dhcpd',
  zrepl: 'zrepl',
  dtrace: 'dtrace',
  git: 'git',
  mtr: 'mtr',
  fping: 'fping',
  lsof: 'lsof',
  sysstat: 'sysstat',
  tree: 'tree',
  tmux: 'tmux',
  'ooce/library/libarchive': 'bsdtar', // libarchive provides bsdtar
  htop: 'htop',
  ncdu: 'ncdu',
  smartmontools: 'smartctl',
  zadm: 'zadm',
  rsync: 'rsync',
  nano: 'nano',
};

const checkPackage = async binaryName => {
  try {
    await execAsync(`which ${binaryName}`);
    return true;
  } catch {
    return false;
  }
};

/**
 * @swagger
 * /provisioning/status:
 *   get:
 *     summary: Get the installation status of all provisioning tools
 *     tags: [Provisioning]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A JSON object with the installation status of each package
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: boolean
 *       500:
 *         description: Failed to get provisioning status
 */
export const getProvisioningStatus = async (req, res) => {
  void req;
  const status = {};
  const packageEntries = Object.entries(packages);

  const results = await Promise.all(
    packageEntries.map(async ([packageName, binaryName]) => {
      const isInstalled = await checkPackage(binaryName);
      return [packageName, isInstalled];
    })
  );

  results.forEach(([name, isInstalled]) => {
    status[name] = isInstalled;
  });

  res.json(status);
};
