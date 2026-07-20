import { log } from '../../lib/Logger.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import {
  componentExists,
  detectActiveInterface,
  getProvNetConfig,
} from './ProvisioningNetworkUtils.js';

export const queueProvisioningNetworkSetup = async createdBy => {
  const netConfig = getProvNetConfig();
  const taskIds = [];
  let lastTaskId = null;

  const parentTask = await Tasks.create({
    zone_name: 'system',
    operation: 'provisioning_network_setup',
    priority: TaskPriority.NORMAL,
    created_by: createdBy,
    status: 'running',
    metadata: JSON.stringify(netConfig),
  });

  const queueTask = async (operation, metadata) => {
    const task = await Tasks.create({
      zone_name: 'system',
      operation,
      priority: TaskPriority.HIGH,
      created_by: createdBy,
      status: 'pending',
      parent_task_id: parentTask.id,
      depends_on: lastTaskId,
      metadata: await new Promise(resolve => {
        yj.stringifyAsync(metadata, (err, result) => {
          void err;
          resolve(result);
        });
      }),
    });
    lastTaskId = task.id;
    taskIds.push(task.id);
    return task;
  };

  if (!(await componentExists('etherstub', netConfig.etherstub_name))) {
    await queueTask('create_etherstub', { name: netConfig.etherstub_name });
  }

  if (!(await componentExists('vnic', netConfig.host_vnic_name))) {
    await queueTask('create_vnic', {
      name: netConfig.host_vnic_name,
      link: netConfig.etherstub_name,
    });
  }

  const addrobj = `${netConfig.host_vnic_name}/v4static`;
  if (!(await componentExists('ip', addrobj))) {
    const prefixLen = netConfig.subnet.split('/')[1] || '24';
    await queueTask('create_ip_address', {
      interface: netConfig.host_vnic_name,
      type: 'static',
      addrobj,
      address: `${netConfig.host_ip}/${prefixLen}`,
    });
  }

  const bridge = await detectActiveInterface();
  if (bridge) {
    await queueTask('create_nat_rule', {
      bridge,
      subnet: netConfig.subnet,
      target: '0/32',
      protocol: 'tcp/udp',
      type: 'portmap',
      created_by: createdBy,
    });

    await queueTask('configure_forwarding', {
      enabled: true,
      interfaces: [bridge, netConfig.host_vnic_name],
    });
  } else {
    log.api.warn('Could not detect active interface for NAT, skipping NAT/Forwarding tasks');
  }

  const [subnetBase] = netConfig.subnet.split('/');
  await queueTask('dhcp_update_config', {
    subnet: subnetBase,
    netmask: netConfig.netmask,
    router: netConfig.host_ip,
    range_start: netConfig.dhcp_range_start,
    range_end: netConfig.dhcp_range_end,
    listen_interface: netConfig.host_vnic_name,
  });

  await queueTask('dhcp_service_control', { action: 'restart' });

  return { parentTaskId: parentTask.id, taskIds, lastTaskId, config: netConfig };
};
