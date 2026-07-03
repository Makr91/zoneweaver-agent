/**
 * @fileoverview Default Recipe Seeder for Zoneweaver Agent
 * @description Seeds 5 default zlogin automation recipes for common OS families.
 *              These recipes automate early-boot network configuration before SSH is available.
 */

import { v4 as uuidv4 } from 'uuid';
import { log } from '../../lib/Logger.js';
import Recipes from '../../models/RecipeModel.js';

/**
 * Default recipes for common operating systems
 * Each recipe includes step-by-step automation for network setup via zlogin console
 */
const defaultRecipes = [
  // 1. Debian 12+ / Ubuntu 18+ (netplan-based)
  {
    id: uuidv4(),
    name: 'debian-netplan',
    description: 'Debian 12+ / Ubuntu 18+ network configuration via netplan',
    os_family: 'linux',
    brand: 'bhyve',
    is_default: true,
    boot_string: 'login:',
    login_prompt: 'login:',
    shell_prompt: ':~$',
    timeout_seconds: 300,
    variables: {
      username: 'root',
      password: 'changeme',
      nic_0_vnic_name: 'enp0s3',
      nic_0_mac: '02:08:20:00:00:01',
      nic_0_ip: '10.190.190.10',
      nic_0_prefix: '24',
      nic_0_gateway: '10.190.190.1',
      nic_0_dns: '8.8.8.8',
    },
    steps: [
      { type: 'wait', pattern: '{{login_prompt}}', timeout: 60 },
      { type: 'send', value: '{{username}}\r\n' },
      { type: 'wait', pattern: 'Password:', timeout: 30 },
      { type: 'send', value: '{{password}}\r\n' },
      { type: 'wait', pattern: '{{shell_prompt}}', timeout: 30 },
      { type: 'command', value: 'sudo su -', expect_prompt: '#', check_exit_code: false },
      { type: 'command', value: 'rm -rf /etc/netplan/*.yaml' },
      {
        type: 'template',
        dest: '/etc/netplan/{{nic_0_vnic_name}}.yaml',
        method: 'heredoc',
        content:
          'network:\n  version: 2\n  ethernets:\n    {{nic_0_vnic_name}}:\n      match:\n        macaddress: "{{nic_0_mac}}"\n      set-name: {{nic_0_vnic_name}}\n      addresses: [{{nic_0_ip}}/{{nic_0_prefix}}]\n      routes:\n        - to: default\n          via: {{nic_0_gateway}}\n      nameservers:\n        addresses: [{{nic_0_dns}}]',
      },
      { type: 'command', value: 'chmod 600 /etc/netplan/{{nic_0_vnic_name}}.yaml' },
      { type: 'command', value: 'netplan apply' },
      { type: 'delay', seconds: 5 },
      { type: 'command', value: 'ip addr show {{nic_0_vnic_name}}' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 2. Older Linux (ifconfig/interfaces-based)
  {
    id: uuidv4(),
    name: 'linux-ifconfig',
    description:
      'Older Linux (Debian 8-11, Ubuntu 16) network configuration via /etc/network/interfaces',
    os_family: 'linux',
    brand: 'bhyve',
    is_default: false,
    boot_string: 'login:',
    login_prompt: 'login:',
    shell_prompt: ':~$',
    timeout_seconds: 300,
    variables: {
      username: 'root',
      password: 'changeme',
      vnic_name: 'eth0',
      ip: '10.190.190.10',
      netmask: '255.255.255.0',
      gateway: '10.190.190.1',
      dns: '8.8.8.8',
    },
    steps: [
      { type: 'wait', pattern: '{{login_prompt}}', timeout: 60 },
      { type: 'send', value: '{{username}}\r\n' },
      { type: 'wait', pattern: 'Password:', timeout: 30 },
      { type: 'send', value: '{{password}}\r\n' },
      { type: 'wait', pattern: '{{shell_prompt}}', timeout: 30 },
      { type: 'command', value: 'sudo su -', expect_prompt: '#', check_exit_code: false },
      {
        type: 'template',
        dest: '/etc/network/interfaces.d/{{vnic_name}}',
        method: 'heredoc',
        content:
          'auto {{vnic_name}}\niface {{vnic_name}} inet static\n  address {{ip}}\n  netmask {{netmask}}\n  gateway {{gateway}}\n  dns-nameservers {{dns}}',
      },
      { type: 'command', value: 'ifdown {{vnic_name}}', check_exit_code: false },
      { type: 'command', value: 'ifup {{vnic_name}}' },
      { type: 'delay', seconds: 5 },
      { type: 'command', value: 'ifconfig {{vnic_name}}' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 3. OmniOS / illumos (dladm/ipadm-based)
  {
    id: uuidv4(),
    name: 'omnios-dladm',
    description: 'OmniOS / illumos network configuration via dladm/ipadm',
    os_family: 'solaris',
    brand: 'bhyve',
    is_default: true,
    boot_string: 'Console login:',
    login_prompt: 'login:',
    shell_prompt: ':~$',
    timeout_seconds: 300,
    variables: {
      username: 'root',
      password: 'changeme',
      vnic_name: 'net0',
      ip: '10.190.190.10',
      prefix: '24',
      gateway: '10.190.190.1',
    },
    steps: [
      { type: 'wait', pattern: '{{login_prompt}}', timeout: 60 },
      { type: 'send', value: '{{username}}\r\n' },
      { type: 'wait', pattern: 'Password:', timeout: 30 },
      { type: 'send', value: '{{password}}\r\n' },
      { type: 'wait', pattern: '{{shell_prompt}}', timeout: 30 },
      {
        type: 'command',
        value: 'pfexec ipadm delete-addr {{vnic_name}}/dhcp',
        check_exit_code: false,
      },
      {
        type: 'command',
        value: 'pfexec ipadm create-addr -T static -a {{ip}}/{{prefix}} {{vnic_name}}/v4static',
      },
      { type: 'command', value: 'pfexec route add default {{gateway}}' },
      { type: 'delay', seconds: 3 },
      { type: 'command', value: 'ipadm show-addr {{vnic_name}}/v4static' },
      { type: 'command', value: 'netstat -rn | grep default' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 4. Windows (SAC console + netsh)
  {
    id: uuidv4(),
    name: 'windows-sac',
    description: 'Windows Server network configuration via SAC console and netsh',
    os_family: 'windows',
    brand: 'bhyve',
    is_default: true,
    boot_string: 'SAC>',
    login_prompt: 'Username:',
    shell_prompt: 'C:\\\\>',
    timeout_seconds: 600,
    variables: {
      username: 'Administrator',
      password: 'changeme',
      interface_name: 'Ethernet',
      ip: '10.190.190.10',
      netmask: '255.255.255.0',
      gateway: '10.190.190.1',
      dns: '8.8.8.8',
    },
    steps: [
      { type: 'wait', pattern: 'SAC>', timeout: 120 },
      { type: 'send', value: 'cmd\r\n' },
      { type: 'wait', pattern: '{{login_prompt}}', timeout: 30 },
      { type: 'send', value: '{{username}}\r\n' },
      { type: 'wait', pattern: 'Domain:', timeout: 30 },
      { type: 'send', value: '\r\n' },
      { type: 'wait', pattern: 'Password:', timeout: 30 },
      { type: 'send', value: '{{password}}\r\n' },
      { type: 'wait', pattern: '{{shell_prompt}}', timeout: 30 },
      {
        type: 'command',
        value:
          'netsh interface ip set address name="{{interface_name}}" static {{ip}} {{netmask}} {{gateway}}',
        expect_prompt: '{{shell_prompt}}',
      },
      {
        type: 'command',
        value: 'netsh interface ip set dns name="{{interface_name}}" static {{dns}}',
        expect_prompt: '{{shell_prompt}}',
      },
      { type: 'delay', seconds: 5 },
      { type: 'command', value: 'ipconfig', expect_prompt: '{{shell_prompt}}' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 5. Cloud-init wait (no zlogin automation needed)
  {
    id: uuidv4(),
    name: 'cloud-init-wait',
    description: 'Wait for cloud-init to configure networking automatically (no zlogin automation)',
    os_family: 'linux',
    brand: 'bhyve',
    is_default: false,
    boot_string: 'Cloud-init',
    login_prompt: 'login:',
    shell_prompt: ':~$',
    timeout_seconds: 600,
    variables: {},
    steps: [
      { type: 'wait', pattern: 'cloud-init.*finished', timeout: 600 },
      { type: 'delay', seconds: 10 },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },
];

/**
 * Seed default recipes into the database
 * @param {Object} queryInterface - Sequelize query interface
 * @returns {Promise<void>}
 */
export const up = async () => {
  // Use Model directly instead of raw queryInterface
  const existingRecipes = await Recipes.findAll({ attributes: ['name'] });
  const existingNames = new Set(existingRecipes.map(r => r.name));

  // Only insert recipes that don't already exist
  const recipesToInsert = defaultRecipes.filter(recipe => !existingNames.has(recipe.name));

  if (recipesToInsert.length === 0) {
    log.database.info('Default recipes already seeded, skipping...');
    return;
  }

  // Convert JSON fields to strings for insertion
  await Recipes.bulkCreate(recipesToInsert);
  log.database.info('Default recipes seeded successfully', {
    count: recipesToInsert.length,
  });
};

/**
 * Rollback: Remove default recipes
 * @param {Object} queryInterface - Sequelize query interface
 * @returns {Promise<void>}
 */
export const down = async () => {
  const recipeNames = defaultRecipes.map(r => r.name);
  await Recipes.destroy({
    where: { name: recipeNames, created_by: 'system' },
  });
  log.database.info('Default recipes removed', {
    count: recipeNames.length,
  });
};
