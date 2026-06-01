export interface Translations {
    // Nav
    dashboard: string;
    logsExplorer: string;
    stepRecorder: string;
    credentials: string;
    systemStatus: string;
    settings: string;
    signOut: string;
    controlPanel: string;
    // Layout header
    systemOnline: string;
    browser: string;
    paused: string;
    live: string;
    idle: string;
    // Home
    newMission: string;
    activeConfigurations: string;
    runningNow: string;
    successLast24h: string;
    failedLast24h: string;
    needsAttention: string;
    totalJobs: string;
    sevenDayHistory: string;
    // Task actions
    run: string;
    retry: string;
    cancel: string;
    enable: string;
    disable: string;
    // Toast
    taskTriggered: string;
    taskTriggeredDesc: string;
    failedToTrigger: string;
    taskEnabled: string;
    taskEnabledDesc: string;
    taskDisabled: string;
    taskDisabledDesc: string;
    cancelRequested: string;
    cancelRequestedDesc: string;
    // Status
    neverRun: string;
    // Misc
    loading: string;
    noTasks: string;
    nextIn: string;
  }

  export const zh: Translations = {
    dashboard: "控制台",
    logsExplorer: "日志查询",
    stepRecorder: "操作录制",
    credentials: "凭证管理",
    systemStatus: "系统状态",
    settings: "设置",
    signOut: "退出登录",
    controlPanel: "控制面板",
    systemOnline: "系统运行中",
    browser: "浏览器",
    paused: "已暂停",
    live: "实时",
    idle: "空闲",
    newMission: "新建任务",
    activeConfigurations: "任务列表",
    runningNow: "运行中",
    successLast24h: "24h 成功",
    failedLast24h: "24h 失败",
    needsAttention: "需处理",
    totalJobs: "任务总数",
    sevenDayHistory: "7日运行记录",
    run: "运行",
    retry: "重试",
    cancel: "取消",
    enable: "启用",
    disable: "禁用",
    taskTriggered: "任务已触发",
    taskTriggeredDesc: "自动化任务已加入队列。",
    failedToTrigger: "触发任务失败",
    taskEnabled: "任务已启用",
    taskEnabledDesc: "任务将按计划运行。",
    taskDisabled: "任务已禁用",
    taskDisabledDesc: "任务已暂停，不会触发。",
    cancelRequested: "取消请求已发送",
    cancelRequestedDesc: "任务即将停止。",
    neverRun: "从未运行",
    loading: "加载中…",
    noTasks: "暂无任务，点击「新建任务」开始",
    nextIn: "距下次",
  };

  export const en: Translations = {
    dashboard: "Dashboard",
    logsExplorer: "Logs Explorer",
    stepRecorder: "Step Recorder",
    credentials: "Credentials",
    systemStatus: "System Status",
    settings: "Settings",
    signOut: "Sign out",
    controlPanel: "Control Panel",
    systemOnline: "System Online",
    browser: "Browser",
    paused: "PAUSED",
    live: "LIVE",
    idle: "IDLE",
    newMission: "New Mission",
    activeConfigurations: "Active Configurations",
    runningNow: "Running Now",
    successLast24h: "Success (24h)",
    failedLast24h: "Failed (24h)",
    needsAttention: "Needs Attention",
    totalJobs: "Total Jobs",
    sevenDayHistory: "7-Day Run History",
    run: "Run",
    retry: "Retry",
    cancel: "Cancel",
    enable: "Enable",
    disable: "Disable",
    taskTriggered: "Task triggered",
    taskTriggeredDesc: "The automation job has been queued.",
    failedToTrigger: "Failed to trigger task",
    taskEnabled: "Task enabled",
    taskEnabledDesc: "The task will run on schedule.",
    taskDisabled: "Task disabled",
    taskDisabledDesc: "The task has been paused.",
    cancelRequested: "Cancel requested",
    cancelRequestedDesc: "The task will stop shortly.",
    neverRun: "never run",
    loading: "Loading…",
    noTasks: "No tasks yet — click New Mission to get started",
    nextIn: "in",
  };
  