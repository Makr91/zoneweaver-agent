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
  // 1. Debian 12+ / Ubuntu 18+ (netplan-based). The agent SYNTHESIZES the
  // complete netplan document for every NIC (dhcp4 vs static per the zone's
  // declared networks[], MAC-matched) into {{netplan_yaml}} — the recipe
  // just writes and applies it. The filename must never be
  // 50-cloud-init.yaml: the networking role's cleanup deletes exactly that.
  {
    id: uuidv4(),
    name: 'debian-netplan',
    description:
      'Debian 12+ / Ubuntu 18+ network configuration via netplan (agent-synthesized document for all NICs)',
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
      netplan_dest: '/etc/netplan/60-zoneweaver.yaml',
      netplan_yaml: 'network:\n  version: 2',
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
        dest: '{{netplan_dest}}',
        method: 'heredoc',
        content: '{{netplan_yaml}}',
      },
      { type: 'command', value: 'chmod 600 {{netplan_dest}}' },
      { type: 'command', value: 'netplan apply' },
      { type: 'delay', seconds: 5 },
      { type: 'command', value: 'ip addr show' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 2. Older Linux (ifconfig/interfaces-based). Discovers the guest-side
  // interface name, then writes static config from the agent-populated
  // nic_0_* variables — DHCP when the document carries no address (an
  // unresolved {{nic_0_ip}} stays literal, which the case pattern detects).
  {
    id: uuidv4(),
    name: 'linux-ifconfig',
    description:
      'Older Linux (Debian 8-11, Ubuntu 16) network configuration via /etc/network/interfaces (agent-populated addressing, DHCP fallback)',
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
    },
    steps: [
      { type: 'wait', pattern: '{{login_prompt}}', timeout: 60 },
      { type: 'send', value: '{{username}}\r\n' },
      { type: 'wait', pattern: 'Password:', timeout: 30 },
      { type: 'send', value: '{{password}}\r\n' },
      { type: 'wait', pattern: '{{shell_prompt}}', timeout: 30 },
      { type: 'command', value: 'sudo su -', expect_prompt: '#', check_exit_code: false },
      {
        type: 'command',
        value:
          "IF=$(ls /sys/class/net | grep -v lo | head -1); IP='{{nic_0_ip}}'; P='{{nic_0_prefix}}'; case $P in *'{{'*) P=24;; esac; case $IP in *'{{'*) printf 'auto %s\\niface %s inet dhcp\\n' $IF $IF > /etc/network/interfaces.d/$IF;; *) printf 'auto %s\\niface %s inet static\\n  address %s/%s\\n' $IF $IF $IP $P > /etc/network/interfaces.d/$IF; G='{{nic_0_gateway}}'; case $G in *'{{'*) :;; *) echo '  gateway' $G >> /etc/network/interfaces.d/$IF;; esac; D='{{nic_0_dns}}'; case $D in *'{{'*) :;; *) echo '  dns-nameservers' $(echo $D | tr , ' ') >> /etc/network/interfaces.d/$IF;; esac;; esac; ifdown $IF 2>/dev/null; ifup $IF",
        check_exit_code: false,
      },
      { type: 'delay', seconds: 5 },
      { type: 'command', value: 'ip addr show 2>/dev/null || ifconfig -a' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 3. OmniOS / illumos (dladm/ipadm-based). Discovers the guest-side link
  // (vioif0 under bhyve, never the host vnic name), addresses from the
  // agent-populated nic_0_* variables, DHCP when the document carries no
  // address. Root's illumos prompt ends '#' — ':~#', not ':~$'.
  {
    id: uuidv4(),
    name: 'omnios-dladm',
    description:
      'OmniOS / illumos network configuration via dladm/ipadm (agent-populated addressing, DHCP fallback)',
    os_family: 'solaris',
    brand: 'bhyve',
    is_default: true,
    boot_string: 'Console login:',
    login_prompt: 'login:',
    shell_prompt: ':~#',
    timeout_seconds: 300,
    variables: {
      username: 'root',
      password: 'changeme',
    },
    steps: [
      { type: 'wait', pattern: '{{login_prompt}}', timeout: 60 },
      { type: 'send', value: '{{username}}\r\n' },
      { type: 'wait', pattern: 'Password:', timeout: 30 },
      { type: 'send', value: '{{password}}\r\n' },
      { type: 'wait', pattern: '{{shell_prompt}}', timeout: 30 },
      {
        type: 'command',
        value:
          "IF=$(dladm show-phys -p -o link | head -1); IP='{{nic_0_ip}}'; P='{{nic_0_prefix}}'; case $P in *'{{'*) P=24;; esac; pfexec ipadm create-if $IF 2>/dev/null; case $IP in *'{{'*) pfexec ipadm create-addr -T dhcp $IF/v4;; *) pfexec ipadm delete-addr $IF/dhcp 2>/dev/null; pfexec ipadm create-addr -T static -a $IP/$P $IF/v4static; G='{{nic_0_gateway}}'; case $G in *'{{'*) :;; *) pfexec route -p add {{nic_0_route}} $G;; esac;; esac",
        check_exit_code: false,
      },
      {
        type: 'command',
        value:
          "D='{{nic_0_dns}}'; case $D in *'{{'*) :;; *) echo $D | tr , ' ' | xargs -n1 echo nameserver | pfexec tee /etc/resolv.conf;; esac",
        check_exit_code: false,
      },
      { type: 'delay', seconds: 3 },
      { type: 'command', value: 'ipadm show-addr' },
      { type: 'command', value: 'netstat -rn' },
    ],
    created_by: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  },

  // 4. Windows (SAC console + PowerShell). Matches the adapter by the
  // agent-populated MAC (never a guessed 'Ethernet' name), static from
  // nic_0_* when the document carries an address, DHCP otherwise — an
  // unresolved {{nic_0_ip}} fails the ^[0-9] test and selects DHCP.
  {
    id: uuidv4(),
    name: 'windows-sac',
    description:
      'Windows Server network configuration via SAC console and PowerShell (MAC-matched adapter, agent-populated addressing, DHCP fallback)',
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
          "powershell -NoProfile -Command \"$m='{{nic_0_mac}}'.ToUpper().Replace(':','-'); $a=Get-NetAdapter | Where-Object {$_.MacAddress -eq $m}; if(-not $a){$a=Get-NetAdapter | Sort-Object ifIndex | Select-Object -First 1}; $ip='{{nic_0_ip}}'; if($ip -match '^[0-9]'){ $p='{{nic_0_prefix}}'; if($p -notmatch '^[0-9]'){$p='24'}; Remove-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue; Remove-NetRoute -InterfaceIndex $a.ifIndex -DestinationPrefix 0.0.0.0/0 -Confirm:$false -ErrorAction SilentlyContinue; $g='{{nic_0_gateway}}'; if($g -match '^[0-9]'){New-NetIPAddress -InterfaceIndex $a.ifIndex -IPAddress $ip -PrefixLength $p -DefaultGateway $g | Out-Null}else{New-NetIPAddress -InterfaceIndex $a.ifIndex -IPAddress $ip -PrefixLength $p | Out-Null}; $d='{{nic_0_dns}}'; if($d -match '^[0-9]'){Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ServerAddresses ($d -split ',')} }else{ Set-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -Dhcp Enabled; Set-DnsClientServerAddress -InterfaceIndex $a.ifIndex -ResetServerAddresses }\"",
        expect_prompt: '{{shell_prompt}}',
        check_exit_code: false,
      },
      { type: 'delay', seconds: 5 },
      { type: 'command', value: 'ipconfig /all', expect_prompt: '{{shell_prompt}}' },
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
