/* 用途：从环境变量加载并校验配置。
不负责：运行代理循环或渲染界面。
输入：环境变量与可选的 .env 文件。
输出：带类型字段的配置对象。
关联：src/agent.js, src/llmClient.js, src/monitor.js。
*/

const path = require("path");
const dotenv = require("dotenv");
const { parseBool, parseFloatValue, parseIntValue } = require("./utils");

dotenv.config();

function loadConfig() {
  const stateDir = process.env.STATE_DIR || "state";
  const journalDir = process.env.JOURNAL_DIR || "journal";
  const logDir = process.env.LOG_DIR || "logs";
  let openaiExtraBody = null;

  const rawExtraBody = process.env.OPENAI_EXTRA_BODY || "";
  if (rawExtraBody.trim()) {
    try {
      openaiExtraBody = JSON.parse(rawExtraBody);
    } catch (err) {
      openaiExtraBody = null;
    }
  }

  const hasNvidiaThinkingConfig =
    Object.prototype.hasOwnProperty.call(process.env, "NVIDIA_ENABLE_THINKING")
    || Object.prototype.hasOwnProperty.call(process.env, "NVIDIA_CLEAR_THINKING");

  if (!openaiExtraBody && hasNvidiaThinkingConfig) {
    openaiExtraBody = {
      chat_template_kwargs: {
        enable_thinking: parseBool(process.env.NVIDIA_ENABLE_THINKING, false),
        clear_thinking: parseBool(process.env.NVIDIA_CLEAR_THINKING, false)
      }
    };
  }

  return {
    vllmBaseUrl: process.env.VLLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    vllmModel: process.env.VLLM_MODEL || "glm-4.7-flash",
    vllmModelA: process.env.VLLM_MODEL_A || "",
    vllmModelB: process.env.VLLM_MODEL_B || "",
    vllmApiKey: process.env.VLLM_API_KEY || "",
    nvidiaApiKey: process.env.NVIDIA_API_KEY || "",
    openaiExtraBody,
    temperature: parseFloatValue(process.env.TEMPERATURE, 0.7),
    topP: parseFloatValue(process.env.TOP_P, 0.9),
    maxTokens: parseIntValue(process.env.MAX_TOKENS, 4096),
    promptWarnChars: parseIntValue(process.env.PROMPT_WARN_CHARS, 12000),
    promptMaxChars: parseIntValue(process.env.PROMPT_MAX_CHARS, 15000),
    requestTimeoutSeconds: parseIntValue(process.env.REQUEST_TIMEOUT_SECONDS, 120),
    maxRetries: parseIntValue(process.env.MAX_RETRIES, 12),
    retryBaseSeconds: parseFloatValue(process.env.RETRY_BASE_SECONDS, 2),
    retryMaxSeconds: parseFloatValue(process.env.RETRY_MAX_SECONDS, 90),
    retryBackoffMultiplier: parseFloatValue(process.env.RETRY_BACKOFF_MULTIPLIER, 2),
    retryJitterSeconds: parseFloatValue(process.env.RETRY_JITTER_SECONDS, 1.5),
    loopSleepSeconds: parseIntValue(process.env.LOOP_SLEEP_SECONDS, 8),
    contextMaxChars: parseIntValue(process.env.CONTEXT_MAX_CHARS, 6000),
    identityUpdateInterval: parseIntValue(process.env.IDENTITY_UPDATE_INTERVAL, 1),
    identityDir: process.env.IDENTITY_DIR || stateDir,
    identityAFile: process.env.IDENTITY_A_FILE || "identity_a.md",
    identityBFile: process.env.IDENTITY_B_FILE || "identity_b.md",
    identityMaxChars: parseIntValue(process.env.IDENTITY_MAX_CHARS, 2000),
    experienceDir: process.env.EXPERIENCE_DIR || stateDir,
    experienceFile: process.env.EXPERIENCE_FILE || "experience.md",
    experienceMaxChars: parseIntValue(process.env.EXPERIENCE_MAX_CHARS, 5000),
    experienceCompressEvery: parseIntValue(process.env.EXPERIENCE_COMPRESS_EVERY, 10),
    experienceCompressMaxItems: parseIntValue(process.env.EXPERIENCE_COMPRESS_MAX_ITEMS, 12),
    freeDebateRounds: parseIntValue(process.env.FREE_DEBATE_ROUNDS, 4),
    skillsPath: process.env.SKILLS_PATH || path.join(stateDir, "skills.json"),
    stateDetector: process.env.STATE_DETECTOR || "rule",
    stateRewardWeight: parseFloatValue(process.env.STATE_REWARD_WEIGHT, 0.8),
    actionMismatchPenalty: parseFloatValue(process.env.ACTION_MISMATCH_PENALTY, 0.6),
    curriculumPhase: parseIntValue(process.env.CURRICULUM_PHASE, 1),
    rlEnabled: parseBool(process.env.RL_ENABLED, true),
    rlDir: process.env.RL_DIR || path.join(stateDir, "rl"),
    rlPolicyFile: process.env.RL_POLICY_FILE || "rl_policy.json",
    rlMetricsFile: process.env.RL_METRICS_FILE || "rl_metrics.json",
    rlHistoryFile: process.env.RL_HISTORY_FILE || "rl_history.jsonl",
    rlLearningRate: parseFloatValue(process.env.RL_LEARNING_RATE, 0.12),
    rlFocusLearningRate: parseFloatValue(process.env.RL_FOCUS_LEARNING_RATE, 0.08),
    rlBaselineAlpha: parseFloatValue(process.env.RL_BASELINE_ALPHA, 0.1),
    rlMinProb: parseFloatValue(process.env.RL_MIN_PROB, 0.03),
    rlActionCount: parseIntValue(process.env.RL_ACTION_COUNT, 2),
    rlExploration: parseFloatValue(process.env.RL_EXPLORATION, 0.1),
    journalDir,
    stateDir,
    logLevel: process.env.LOG_LEVEL || "INFO",
    logDir,
    logFile: process.env.LOG_FILE || path.join(logDir, "wanderer.log"),
    logMaxBytes: parseIntValue(process.env.LOG_MAX_BYTES, 5 * 1024 * 1024),
    logMaxFiles: parseIntValue(process.env.LOG_MAX_FILES, 5)
  };
}

module.exports = { loadConfig };
