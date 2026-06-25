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
    inQueue: string;
    sevenDayHistory: string;
    dashboardSubtitle: string;
    successVsFailure: string;
    clickToFilter: string;
    clickToReset: string;
    failedToUpdate: string;
    filterEmptyNeedsAttention: string;
    filterEmptyRunning: string;
    filterEmptySuccess: string;
    filterEmptyFailed: string;
    showAllTasks: string;
    reset: string;
    showing: string;
    blockedTasks: string;
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
    // StatusBadge
    statusSuccess: string;
    statusFailed: string;
    statusRunning: string;
    statusQueued: string;
    statusNeedsAttention: string;
    // TaskForm
    newTask: string;
    editTask: string;
    taskName: string;
    taskNamePlaceholder: string;
    targetUrl: string;
    targetUrlPlaceholder: string;
    schedule: string;
    noSchedule: string;
    cronExpression: string;
    randomSchedule: string;
    afterCompletion: string;
    browserConfig: string;
    enableBrowserConfig: string;
    provider: string;
    wsEndpoint: string;
    proxy: string;
    stealthMode: string;
    blockAds: string;
    ignoreHTTPS: string;
    sessionTimeout: string;
    workflowSteps: string;
    addStep: string;
    saveTask: string;
    saving: string;
    taskCreated: string;
    taskUpdated: string;
    failedToSave: string;
    failedToLoad: string;
    stepsImported: string;
    randomWindow: string;
    timesPerCycle: string;
    afterCompletionDesc: string;
    // TaskDetail
    editTask2: string;
    deleteTask: string;
    confirmDelete: string;
    confirmDeleteDesc: string;
    confirmDeleteBtn: string;
    taskNotFound: string;
    taskDeleted: string;
    failedToDelete: string;
    enabled: string;
    disabled: string;
    lastRun: string;
    nextRun: string;
    runHistory: string;
    noLogs: string;
    viewLog: string;
    taskConfig: string;
    browserProvider: string;
    runTaskNow: string;
    taskCancelled: string;
    failedToCancel: string;
    updatedAgo: string;
    runningStream: string;
    // LogDetail
    backToTask: string;
    executionLog: string;
    startedAt: string;
    duration: string;
    steps: string;
    noLogData: string;
    // LogsExplorer
    allTasks: string;
    filterByTask: string;
    filterByStatus: string;
    allStatuses: string;
    noLogsFound: string;
    task: string;
    date: string;
    status: string;
    // Credentials
    addCredential: string;
    editCredential: string;
    credentialName: string;
    username: string;
    password: string;
    totp: string;
    totpPlaceholder: string;
    saveCredential: string;
    deleteCredential: string;
    confirmDeleteCred: string;
    confirmDeleteCredDesc: string;
    credentialSaved: string;
    credentialUpdated: string;
    credentialDeleted: string;
    failedToSaveCred: string;
    failedToDeleteCred: string;
    noCredentials: string;
    // Settings
    retentionSettings: string;
    logRetentionDays: string;
    logRetentionDesc: string;
    maxScreenshotStorage: string;
    maxScreenshotDesc: string;
    runCleanupNow: string;
    retentionSaved: string;
    cleanupComplete: string;
    cleanupCompleteDesc: string;
    cleanupFailed: string;
    saveFailed: string;
    networkError: string;
    pollingInterval: string;
    pollingIntervalDesc: string;
    changePassword: string;
    currentPassword: string;
    newPassword: string;
    repeatPassword: string;
    passwordChanged: string;
    passwordChangeFailed: string;
    wrongPassword: string;
    passwordMismatch: string;
    taskTimeout: string;
    taskTimeoutDesc: string;
    timeoutDisabled: string;
    timeoutCustom: string;
    timeoutMinutes: string;
    captchaSettings: string;
    captchaProvider: string;
    noCaptcha: string;
    captchaSaved: string;
    aboutSystem: string;
    version: string;
    uptime: string;
    database: string;
    dbConnected: string;
    dbError: string;
    systemInfoFailed: string;
    browserSettings: string;
    testConnection: string;
    connectionOk: string;
    connectionFailed: string;
    browserSettingsSaved: string;
    // Status page
    allSystemsOk: string;
    systemsDegraded: string;
    taskScheduler: string;
    browserService: string;
    // Login / Setup
    signIn: string;
    enterPassword: string;
    invalidPassword: string;
    setupTitle: string;
    setupDesc: string;
    repeatPasswordPlaceholder: string;
    setPassword: string;
    settingUp: string;
    // Recorder
    stepRecorderTitle: string;
    startSession: string;
    stopSession: string;
    takeScreenshot: string;
    copySteps: string;
    loadToForm: string;
    clearSteps: string;
    enterUrl: string;
    startingBrowser: string;
    sessionActive: string;
    noStepsYet: string;
    stepsCopied: string;
    stepsLoaded: string;
    screenshotTaken: string;
    failedToStart: string;
    // not-found
    pageNotFound: string;
    pageNotFoundHint: string;
      // TaskDetail
      returnToDashboard: string;
      stopThisTask: string;
      keepRunning: string;
      areYouSure: string;
      captchaDetected: string;
      loginStrategy: string;
      manualOnly: string;
      lastExecution: string;
      stopRequested: string;
      stopRequestedDesc: string;
      couldNotStop: string;
      failedToReachServer: string;
      alreadyRunning: string;
      alreadyRunningDesc: string;
      retryMission: string;
      postcheckScreenshot: string;
      // Settings
      maxConcurrentSessions: string;
      advancedOptions: string;
      testUrl: string;
      platformConfig: string;
      intervalFastest: string;
      intervalBalanced: string;
      intervalSlower: string;
      platform: string;
      // Recorder
      startRecording: string;
      startingUrl: string;
      howItWorks: string;
      copiedLabel: string;
      copyJson: string;
      quickLabel: string;
      // LogDetail
      logNotFound: string;
      timestamp: string;
      result: string;
      executionScreenshot: string;
      stepScreenshot: string;
      finalScreenshot: string;
      dryRun: string;
      executionAborted: string;
      completedWithoutErrors: string;
      // Status
      schedulerError: string;
      apiServerError: string;
      dbQueryFailed: string;
      // StepEditor - step types
      stepLogin: string;
      stepLoginDesc: string;
      stepNavigate: string;
      stepNavigateDesc: string;
      stepClick: string;
      stepClickDesc: string;
      stepFill: string;
      stepFillDesc: string;
      stepSelectOpt: string;
      stepSelectOptDesc: string;
      stepScroll: string;
      stepScrollDesc: string;
      stepHover: string;
      stepHoverDesc: string;
      stepWait: string;
      stepWaitDesc: string;
      stepWaitFor: string;
      stepWaitForDesc: string;
      stepScreenshotType: string;
      stepScreenshotTypeDesc: string;
      stepSwitchTab: string;
      stepSwitchTabDesc: string;
      stepKeyPress: string;
      stepKeyPressDesc: string;
      stepCondition: string;
      stepConditionDesc: string;
      // StepEditor - UI labels
      loginMethod: string;
      standardForm: string;
      loginPageUrl: string;
      useSavedCredential: string;
      enterInline: string;
      selectCredential: string;
      noSavedCredentials: string;
      successSelector: string;
      successText: string;
      ifCondition: string;
      textContains: string;
      textNotContains: string;
      elementVisible: string;
      elementNotVisible: string;
      urlContains: string;
      conditionValue: string;
      conditionSelector: string;
      thenExecute: string;
      moveUp: string;
      moveDown: string;
      removeStep: string;
      importJson: string;
      clearAll: string;
      noStepsAdded: string;
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
    inQueue: "排队中",
    dashboardSubtitle: "系统概览与自动化任务",
    successVsFailure: "每日成功/失败统计",
    clickToFilter: "点击筛选",
    clickToReset: "点击重置",
    failedToUpdate: "更新任务失败",
    filterEmptyNeedsAttention: "所有任务运行正常，暂无需处理的任务。",
    filterEmptyRunning: "当前没有正在运行的任务。",
    filterEmptySuccess: "最近没有成功完成的任务。",
    filterEmptyFailed: "最近没有失败的任务。",
    showAllTasks: "显示所有任务",
    reset: "重置",
    showing: "正在显示",
    blockedTasks: "被阻塞",

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
    statusSuccess: "成功",
    statusFailed: "失败",
    statusRunning: "运行中",
    statusQueued: "排队中",
    statusNeedsAttention: "需处理",
    newTask: "新建任务",
    editTask: "编辑任务",
    taskName: "任务名称",
    taskNamePlaceholder: "输入任务名称",
    targetUrl: "目标 URL",
    targetUrlPlaceholder: "https://example.com",
    schedule: "调度计划",
    noSchedule: "不自动调度",
    cronExpression: "Cron 表达式",
    randomSchedule: "随机调度",
    afterCompletion: "完成后再次运行",
    browserConfig: "浏览器配置",
    enableBrowserConfig: "启用自定义浏览器配置",
    provider: "驱动",
    wsEndpoint: "WebSocket 地址",
    proxy: "代理地址",
    stealthMode: "隐身模式",
    blockAds: "屏蔽广告",
    ignoreHTTPS: "忽略 HTTPS 错误",
    sessionTimeout: "会话超时（毫秒）",
    workflowSteps: "工作流步骤",
    addStep: "添加步骤",
    saveTask: "保存任务",
    saving: "保存中…",
    taskCreated: "任务已创建",
    taskUpdated: "任务已更新",
    failedToSave: "保存失败",
    failedToLoad: "加载失败",
    stepsImported: "已导入步骤",
    randomWindow: "时间窗口",
    timesPerCycle: "每个周期内执行次数",
    afterCompletionDesc: "分钟后",
    editTask2: "编辑",
    deleteTask: "删除任务",
    confirmDelete: "确认删除",
    confirmDeleteDesc: "此操作不可撤销，任务及其所有历史日志将被永久删除。",
    confirmDeleteBtn: "确认删除",
    taskNotFound: "任务未找到",
    taskDeleted: "任务已删除",
    failedToDelete: "删除失败",
    enabled: "已启用",
    disabled: "已禁用",
    lastRun: "上次运行",
    nextRun: "下次运行",
    runHistory: "运行历史",
    noLogs: "暂无运行记录",
    viewLog: "查看日志",
    taskConfig: "任务配置",
    browserProvider: "浏览器驱动",
    runTaskNow: "立即运行",
    taskCancelled: "任务已取消",
    failedToCancel: "取消失败",
    updatedAgo: "刷新于",
    runningStream: "实时日志",
    backToTask: "返回任务",
    executionLog: "执行日志",
    startedAt: "开始时间",
    duration: "耗时",
    steps: "步骤",
    noLogData: "暂无日志数据",
    allTasks: "所有任务",
    filterByTask: "按任务筛选",
    filterByStatus: "按状态筛选",
    allStatuses: "所有状态",
    noLogsFound: "未找到日志",
    task: "任务",
    date: "时间",
    status: "状态",
    addCredential: "添加凭证",
    editCredential: "编辑凭证",
    credentialName: "凭证名称",
    username: "用户名",
    password: "密码",
    totp: "TOTP 密钥（可选）",
    totpPlaceholder: "Base32 密钥",
    saveCredential: "保存凭证",
    deleteCredential: "删除凭证",
    confirmDeleteCred: "确认删除凭证",
    confirmDeleteCredDesc: "此操作不可撤销，凭证将被永久删除。",
    credentialSaved: "凭证已保存",
    credentialUpdated: "凭证已更新",
    credentialDeleted: "凭证已删除",
    failedToSaveCred: "保存凭证失败",
    failedToDeleteCred: "删除凭证失败",
    noCredentials: "暂无凭证，点击「添加凭证」开始",
    retentionSettings: "日志与截图保留策略",
    logRetentionDays: "日志保留天数",
    logRetentionDesc: "超过此天数的日志将在每天 03:30 自动删除。设为 0 表示永久保留。",
    maxScreenshotStorage: "截图最大存储空间（MB）",
    maxScreenshotDesc: "磁盘用量超过此值时，最旧的截图将被自动删除。设为 0 表示不限制。",
    runCleanupNow: "立即清理",
    retentionSaved: "保留策略已保存",
    cleanupComplete: "清理完成",
    cleanupCompleteDesc: "旧日志和截图已清除。",
    cleanupFailed: "清理失败",
    saveFailed: "保存失败",
    networkError: "网络错误",
    pollingInterval: "数据刷新间隔",
    pollingIntervalDesc: "控制页面自动刷新的频率（对当前设备生效）。",
    changePassword: "修改密码",
    currentPassword: "当前密码",
    newPassword: "新密码",
    repeatPassword: "确认新密码",
    passwordChanged: "密码已修改",
    passwordChangeFailed: "密码修改失败",
    wrongPassword: "当前密码错误",
    passwordMismatch: "两次输入的密码不一致",
    taskTimeout: "任务超时设置",
    taskTimeoutDesc: "任务运行超过此时长后将被自动终止。",
    timeoutDisabled: "不限制",
    timeoutCustom: "自定义",
    timeoutMinutes: "分钟",
    captchaSettings: "验证码破解设置",
    captchaProvider: "验证码服务商",
    noCaptcha: "不使用",
    captchaSaved: "验证码设置已保存",
    aboutSystem: "系统信息",
    version: "版本",
    uptime: "运行时长",
    database: "数据库",
    dbConnected: "已连接",
    dbError: "连接失败",
    systemInfoFailed: "无法加载系统信息",
    browserSettings: "浏览器连接设置",
    testConnection: "测试连接",
    connectionOk: "连接成功",
    connectionFailed: "连接失败",
    browserSettingsSaved: "浏览器设置已保存",
    allSystemsOk: "所有服务运行正常",
    systemsDegraded: "部分服务异常",
    taskScheduler: "任务调度器",
    browserService: "浏览器服务",
    signIn: "登录",
    enterPassword: "输入密码",
    invalidPassword: "密码错误",
    setupTitle: "初始化设置",
    setupDesc: "设置管理员密码以完成初始化",
    repeatPasswordPlaceholder: "再次输入密码",
    setPassword: "设置密码",
    settingUp: "初始化中…",
    stepRecorderTitle: "操作录制",
    startSession: "启动浏览器",
    stopSession: "停止会话",
    takeScreenshot: "截图",
    copySteps: "复制步骤",
    loadToForm: "导入到任务",
    clearSteps: "清空步骤",
    enterUrl: "输入目标 URL",
    startingBrowser: "正在启动浏览器…",
    sessionActive: "会话运行中",
    noStepsYet: "暂无录制步骤",
    stepsCopied: "步骤已复制到剪贴板",
    stepsLoaded: "步骤已导入任务表单",
    screenshotTaken: "截图已保存",
    failedToStart: "启动浏览器会话失败",
    pageNotFound: "404 页面不存在",
    pageNotFoundHint: "该页面不存在或已被移除。",
  
      returnToDashboard: "返回控制台",
      stopThisTask: "停止此任务？",
      keepRunning: "继续运行",
      areYouSure: "确认操作？",
      captchaDetected: "检测到验证码 — 需要手动处理",
      loginStrategy: "登录策略",
      manualOnly: "仅手动",
      lastExecution: "上次执行",
      stopRequested: "停止请求已发送",
      stopRequestedDesc: "任务将在当前步骤完成后停止。",
      couldNotStop: "无法停止",
      failedToReachServer: "无法连接到服务器",
      alreadyRunning: "已在运行中",
      alreadyRunningDesc: "此任务已在进行中。",
      retryMission: "重试任务",
      postcheckScreenshot: "事后截图",
      maxConcurrentSessions: "最大并发会话数",
      advancedOptions: "高级选项",
      testUrl: "测试 URL",
      platformConfig: "平台配置与偏好设置",
      intervalFastest: "1秒 — 最快，服务器负载较高",
      intervalBalanced: "2秒 — 均衡（默认）",
      intervalSlower: "5秒 — 较慢，减少网络使用",
      platform: "平台",
      startRecording: "开始录制",
      startingUrl: "起始 URL",
      howItWorks: "使用方法",
      copiedLabel: "已复制！",
      copyJson: "复制 JSON",
      quickLabel: "快捷：",
      logNotFound: "日志未找到",
      timestamp: "时间",
      result: "结果",
      executionScreenshot: "执行截图",
      stepScreenshot: "步骤截图",
      finalScreenshot: "最终截图",
      dryRun: "预演",
      executionAborted: "执行已中止",
      completedWithoutErrors: "无错误完成",
      schedulerError: "无法连接到调度器",
      apiServerError: "无法连接到 API 服务器",
      dbQueryFailed: "数据库查询失败",
      stepLogin: "登录",
      stepLoginDesc: "通过表单、GitHub 或 Google OAuth 认证",
      stepNavigate: "导航",
      stepNavigateDesc: "跳转到 URL",
      stepClick: "点击",
      stepClickDesc: "点击元素",
      stepFill: "填写输入",
      stepFillDesc: "在输入框中输入文字",
      stepSelectOpt: "选择选项",
      stepSelectOptDesc: "从下拉框选择",
      stepScroll: "滚动",
      stepScrollDesc: "滚动页面或元素到视图",
      stepHover: "悬停",
      stepHoverDesc: "鼠标悬停到元素上",
      stepWait: "等待",
      stepWaitDesc: "暂停 N 毫秒",
      stepWaitFor: "等待出现",
      stepWaitForDesc: "等待元素或文字出现",
      stepScreenshotType: "截图",
      stepScreenshotTypeDesc: "截取当前页面",
      stepSwitchTab: "切换新标签页",
      stepSwitchTabDesc: "切换焦点到新打开的标签页",
      stepKeyPress: "按键",
      stepKeyPressDesc: "发送键盘快捷键或按键",
      stepCondition: "条件",
      stepConditionDesc: "条件成立时执行操作",
      loginMethod: "登录方式",
      standardForm: "标准表单",
      loginPageUrl: "登录页 URL",
      useSavedCredential: "使用已保存凭证",
      enterInline: "手动输入",
      selectCredential: "选择已保存的凭证…",
      noSavedCredentials: "暂无已保存凭证，请手动输入或前往",
      successSelector: "成功选择器",
      successText: "成功文本",
      ifCondition: "条件类型",
      textContains: "页面包含文字",
      textNotContains: "页面不包含文字",
      elementVisible: "元素可见",
      elementNotVisible: "元素不可见",
      urlContains: "URL 包含",
      conditionValue: "匹配值",
      conditionSelector: "元素选择器（可选）",
      thenExecute: "满足条件时执行",
      moveUp: "上移",
      moveDown: "下移",
      removeStep: "删除步骤",
      importJson: "导入 JSON",
      clearAll: "清空全部",
      noStepsAdded: "尚未添加步骤",
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
    inQueue: "In Queue",
    dashboardSubtitle: "System overview and automation jobs",
    successVsFailure: "success vs failure per day",
    clickToFilter: "click to filter",
    clickToReset: "click to reset",
    failedToUpdate: "Failed to update task",
    filterEmptyNeedsAttention: "All tasks are running smoothly — nothing needs your attention right now.",
    filterEmptyRunning: "No tasks are currently running.",
    filterEmptySuccess: "No tasks have succeeded recently.",
    filterEmptyFailed: "No tasks have failed recently.",
    showAllTasks: "Show all tasks",
    reset: "Reset",
    showing: "Showing",
    blockedTasks: "blocked",
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
    statusSuccess: "SUCCESS",
    statusFailed: "FAILED",
    statusRunning: "RUNNING",
    statusQueued: "QUEUED",
    statusNeedsAttention: "NEEDS ATTENTION",
    newTask: "New Task",
    editTask: "Edit Task",
    taskName: "Task Name",
    taskNamePlaceholder: "Enter task name",
    targetUrl: "Target URL",
    targetUrlPlaceholder: "https://example.com",
    schedule: "Schedule",
    noSchedule: "No schedule",
    cronExpression: "Cron expression",
    randomSchedule: "Random schedule",
    afterCompletion: "Run again after completion",
    browserConfig: "Browser Config",
    enableBrowserConfig: "Enable custom browser config",
    provider: "Provider",
    wsEndpoint: "WebSocket endpoint",
    proxy: "Proxy URL",
    stealthMode: "Stealth mode",
    blockAds: "Block ads",
    ignoreHTTPS: "Ignore HTTPS errors",
    sessionTimeout: "Session timeout (ms)",
    workflowSteps: "Workflow Steps",
    addStep: "Add Step",
    saveTask: "Save Task",
    saving: "Saving…",
    taskCreated: "Task created",
    taskUpdated: "Task updated",
    failedToSave: "Failed to save",
    failedToLoad: "Failed to load",
    stepsImported: "steps imported",
    randomWindow: "Time window",
    timesPerCycle: "Times per cycle",
    afterCompletionDesc: "minutes after completion",
    editTask2: "Edit",
    deleteTask: "Delete Task",
    confirmDelete: "Confirm Delete",
    confirmDeleteDesc: "This action cannot be undone. The task and all its logs will be permanently deleted.",
    confirmDeleteBtn: "Delete",
    taskNotFound: "Task not found",
    taskDeleted: "Task deleted",
    failedToDelete: "Failed to delete",
    enabled: "Enabled",
    disabled: "Disabled",
    lastRun: "Last run",
    nextRun: "Next run",
    runHistory: "Run History",
    noLogs: "No run history yet",
    viewLog: "View log",
    taskConfig: "Task Config",
    browserProvider: "Browser provider",
    runTaskNow: "Run now",
    taskCancelled: "Task cancelled",
    failedToCancel: "Failed to cancel",
    updatedAgo: "Updated",
    runningStream: "Live log",
    backToTask: "Back to task",
    executionLog: "Execution Log",
    startedAt: "Started at",
    duration: "Duration",
    steps: "Steps",
    noLogData: "No log data",
    allTasks: "All tasks",
    filterByTask: "Filter by task",
    filterByStatus: "Filter by status",
    allStatuses: "All statuses",
    noLogsFound: "No logs found",
    task: "Task",
    date: "Date",
    status: "Status",
    addCredential: "Add Credential",
    editCredential: "Edit Credential",
    credentialName: "Name",
    username: "Username",
    password: "Password",
    totp: "TOTP secret (optional)",
    totpPlaceholder: "Base32 secret",
    saveCredential: "Save",
    deleteCredential: "Delete",
    confirmDeleteCred: "Delete credential",
    confirmDeleteCredDesc: "This action cannot be undone.",
    credentialSaved: "Credential saved",
    credentialUpdated: "Credential updated",
    credentialDeleted: "Credential deleted",
    failedToSaveCred: "Failed to save credential",
    failedToDeleteCred: "Failed to delete credential",
    noCredentials: "No credentials yet — click Add Credential to get started",
    retentionSettings: "Log & Screenshot Retention",
    logRetentionDays: "Log retention (days)",
    logRetentionDesc: "Logs older than this are deleted each night at 03:30. Set 0 to keep forever.",
    maxScreenshotStorage: "Max screenshot storage (MB)",
    maxScreenshotDesc: "Oldest screenshots are removed when disk usage exceeds this. Set 0 for no limit.",
    runCleanupNow: "Run cleanup now",
    retentionSaved: "Retention settings saved",
    cleanupComplete: "Cleanup complete",
    cleanupCompleteDesc: "Old logs and screenshots have been removed.",
    cleanupFailed: "Cleanup failed",
    saveFailed: "Save failed",
    networkError: "Network error",
    pollingInterval: "Polling interval",
    pollingIntervalDesc: "Controls how often the page auto-refreshes data (applies to this device only).",
    changePassword: "Change Password",
    currentPassword: "Current password",
    newPassword: "New password",
    repeatPassword: "Repeat new password",
    passwordChanged: "Password changed",
    passwordChangeFailed: "Failed to change password",
    wrongPassword: "Current password is incorrect",
    passwordMismatch: "Passwords do not match",
    taskTimeout: "Task Timeout",
    taskTimeoutDesc: "Tasks running longer than this will be automatically terminated.",
    timeoutDisabled: "Disabled",
    timeoutCustom: "Custom",
    timeoutMinutes: "minutes",
    captchaSettings: "Captcha Settings",
    captchaProvider: "Provider",
    noCaptcha: "None",
    captchaSaved: "Captcha settings saved",
    aboutSystem: "About",
    version: "Version",
    uptime: "Uptime",
    database: "Database",
    dbConnected: "connected",
    dbError: "error",
    systemInfoFailed: "Unable to load system information.",
    browserSettings: "Browser Connection",
    testConnection: "Test connection",
    connectionOk: "Connection successful",
    connectionFailed: "Connection failed",
    browserSettingsSaved: "Browser settings saved",
    allSystemsOk: "All systems operational",
    systemsDegraded: "One or more services are degraded",
    taskScheduler: "Task Scheduler",
    browserService: "Browser Service",
    signIn: "Sign in",
    enterPassword: "Enter password",
    invalidPassword: "Invalid password",
    setupTitle: "Initial Setup",
    setupDesc: "Set an admin password to get started",
    repeatPasswordPlaceholder: "Repeat password",
    setPassword: "Set Password",
    settingUp: "Setting up…",
    stepRecorderTitle: "Step Recorder",
    startSession: "Start browser",
    stopSession: "Stop session",
    takeScreenshot: "Screenshot",
    copySteps: "Copy steps",
    loadToForm: "Load to task form",
    clearSteps: "Clear steps",
    enterUrl: "Enter target URL",
    startingBrowser: "Starting browser…",
    sessionActive: "Session active",
    noStepsYet: "No steps recorded yet",
    stepsCopied: "Steps copied to clipboard",
    stepsLoaded: "Steps loaded into task form",
    screenshotTaken: "Screenshot saved",
    failedToStart: "Failed to start browser session",
    pageNotFound: "404 Page Not Found",
    pageNotFoundHint: "Did you forget to add the page to the router?",
  
      returnToDashboard: "Return to Dashboard",
      stopThisTask: "Stop this task?",
      keepRunning: "Keep running",
      areYouSure: "Are you absolutely sure?",
      captchaDetected: "Captcha Detected — Manual Action Required",
      loginStrategy: "Login Strategy",
      manualOnly: "Manual only",
      lastExecution: "Last Execution",
      stopRequested: "Stop requested",
      stopRequestedDesc: "The task will stop after the current step completes.",
      couldNotStop: "Could not stop",
      failedToReachServer: "Failed to reach server",
      alreadyRunning: "Already running",
      alreadyRunningDesc: "This task is already in progress.",
      retryMission: "Retry Mission",
      postcheckScreenshot: "Postcheck screenshot",
      maxConcurrentSessions: "Max concurrent sessions",
      advancedOptions: "Advanced Options",
      testUrl: "Test URL",
      platformConfig: "Platform configuration and preferences",
      intervalFastest: "1 second — fastest, higher server load",
      intervalBalanced: "2 seconds — balanced (default)",
      intervalSlower: "5 seconds — slower, reduced network usage",
      platform: "Platform",
      startRecording: "Start Recording",
      startingUrl: "Starting URL",
      howItWorks: "How it works",
      copiedLabel: "Copied!",
      copyJson: "Copy JSON",
      quickLabel: "Quick:",
      logNotFound: "Log not found",
      timestamp: "Timestamp",
      result: "Result",
      executionScreenshot: "Execution Screenshot",
      stepScreenshot: "Step Screenshot",
      finalScreenshot: "Final Screenshot",
      dryRun: "Dry Run",
      executionAborted: "Execution aborted",
      completedWithoutErrors: "Completed without errors",
      schedulerError: "Could not reach the scheduler",
      apiServerError: "Could not reach the API server",
      dbQueryFailed: "Database query failed",
      stepLogin: "Login",
      stepLoginDesc: "Authenticate via form, GitHub, or Google OAuth",
      stepNavigate: "Navigate",
      stepNavigateDesc: "Go to a URL",
      stepClick: "Click",
      stepClickDesc: "Click an element",
      stepFill: "Fill Input",
      stepFillDesc: "Type into a field",
      stepSelectOpt: "Select Option",
      stepSelectOptDesc: "Choose from a dropdown",
      stepScroll: "Scroll",
      stepScrollDesc: "Scroll page or element into view",
      stepHover: "Hover",
      stepHoverDesc: "Mouse over an element",
      stepWait: "Wait",
      stepWaitDesc: "Pause for N milliseconds",
      stepWaitFor: "Wait For",
      stepWaitForDesc: "Wait until element or text appears",
      stepScreenshotType: "Screenshot",
      stepScreenshotTypeDesc: "Capture current page",
      stepSwitchTab: "Switch to New Tab",
      stepSwitchTabDesc: "Switch focus to the newly opened tab",
      stepKeyPress: "Key Press",
      stepKeyPressDesc: "Send a keyboard shortcut or key",
      stepCondition: "Condition",
      stepConditionDesc: "If condition is met, execute an action",
      loginMethod: "Login Method",
      standardForm: "Standard Form",
      loginPageUrl: "Login Page URL",
      useSavedCredential: "Use saved credential",
      enterInline: "Enter inline",
      selectCredential: "Select a saved credential…",
      noSavedCredentials: "No saved credentials yet. Enter inline or add one in",
      successSelector: "Success Selector",
      successText: "Success Text",
      ifCondition: "If condition",
      textContains: "Page contains text",
      textNotContains: "Page does NOT contain text",
      elementVisible: "Element is visible",
      elementNotVisible: "Element is NOT visible",
      urlContains: "URL contains",
      conditionValue: "Match value",
      conditionSelector: "Element selector (optional)",
      thenExecute: "Then execute",
      moveUp: "Move up",
      moveDown: "Move down",
      removeStep: "Remove step",
      importJson: "Import JSON",
      clearAll: "Clear all",
      noStepsAdded: "No steps added yet",
  };
  