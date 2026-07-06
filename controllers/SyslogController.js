/**
 * @fileoverview Syslog Configuration Controller — aggregating index
 * @description Syslog configuration management. The implementation lives in
 * ./Syslog/ (config endpoints, service endpoints, parsing helpers); this
 * index preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import {
  getSyslogConfig,
  updateSyslogConfig,
  getSyslogFacilities,
  validateSyslogConfig,
} from './Syslog/SyslogConfigController.js';
import { reloadSyslogService, switchSyslogService } from './Syslog/SyslogServiceController.js';

export {
  getSyslogConfig,
  updateSyslogConfig,
  getSyslogFacilities,
  validateSyslogConfig,
  reloadSyslogService,
  switchSyslogService,
};

export default {
  getSyslogConfig,
  updateSyslogConfig,
  getSyslogFacilities,
  validateSyslogConfig,
  reloadSyslogService,
};
