/* 用途：调用 OpenAI 兼容接口（zhipu 或 vLLM）并带重试机制与状态追踪。
不负责：提示词构建或命令执行。
输入：系统/用户提示词与生成参数。
输出：模型响应文本，供后续解析。
关联：src/agent.js, src/config.js, src/logger.js。
*/

const OpenAI = require("openai");
const { nowIso } = require("./utils");

class LlmClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = this.createClient();
    this.status = {
      ok: true,
      last_error: "",
      last_status: null,
      last_latency_ms: null,
      last_success_at: null,
      last_failure_at: null,
      retrying: false,
      last_retry_at: null,
      last_retry_attempt: 0,
      last_retry_error: ""
    };
  }

  createClient() {
    const baseUrl = this.normalizeBaseUrl(this.config.vllmBaseUrl);
    if (!baseUrl) {
      throw new Error("VLLM_BASE_URL is empty");
    }
    const isLocalVllm = this.isLocalAddress(baseUrl);
    const apiKey = this.config.vllmApiKey || this.config.nvidiaApiKey || (isLocalVllm ? "EMPTY" : "");

    if (baseUrl !== this.config.vllmBaseUrl) {
      this.logger?.warn("llm.base_url.normalized", {
        before: this.config.vllmBaseUrl,
        after: baseUrl,
        isLocalVllm
      });
    }

    const openaiBaseUrl = isLocalVllm
      ? `${baseUrl.replace(/\/$/, "")}/v1`
      : baseUrl.replace(/\/$/, "");

    return new OpenAI({
      baseURL: openaiBaseUrl,
      apiKey,
      timeout: this.config.requestTimeoutSeconds * 1000,
      maxRetries: 0
    });
  }

  isLocalAddress(baseUrl) {
    const patterns = [
      /^localhost/i,
      /^127\.0\.0\.1/i,
      /^0\.0\.0\.0/i,
      /^::1$/,
      /^192\.168\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^\[::1\]$/i,
      /^\[fe80:/i
    ];
    const hostname = baseUrl.replace(/^https?:\/\//i, "").replace(/:[0-9]+.*$/, "").replace(/^\[|\]$/g, "");
    return patterns.some((pattern) => pattern.test(hostname));
  }

  getStatus() {
    return { ...this.status };
  }

  async chat(systemPrompt, userPrompt, options = {}) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptChars = (systemPrompt?.length || 0) + (userPrompt?.length || 0);
    const model = options.model || this.config.vllmModel;
    const requestOptions = {
      temperature: Number.isFinite(options.temperature) ? options.temperature : undefined,
      topP: Number.isFinite(options.topP) ? options.topP : undefined,
      maxTokens: Number.isFinite(options.maxTokens) ? options.maxTokens : undefined,
      extraBody: options.extraBody
    };

    this.status.retrying = false;
    this.status.last_retry_at = null;
    this.status.last_retry_attempt = 0;
    this.status.last_retry_error = "";

    this.logger?.info("llm.request.start", {
      requestId,
      model,
      promptChars,
      isLocalVllm: this.isLocalAddress(this.config.vllmBaseUrl)
    });

    try {
      const startAt = Date.now();
      const response = await this.chatWithRetry(systemPrompt, userPrompt, requestId, model, requestOptions);
      const ms = Date.now() - startAt;

      this.status.ok = true;
      this.status.last_error = "";
      this.status.last_status = 200;
      this.status.last_latency_ms = ms;
      this.status.last_success_at = nowIso();
      this.status.retrying = false;

      this.logger?.info("llm.request.success", {
        requestId,
        status: 200,
        ms,
        tokens: response.usage?.total_tokens || null
      });

      return {
        content: response.content,
        usage: response.usage || null
      };
    } catch (err) {
      const status = err?.status || err?.statusCode || null;
      const errorMsg = err?.message || String(err);
      this.status.ok = false;
      this.status.last_error = errorMsg;
      this.status.last_status = status;
      this.status.last_failure_at = nowIso();
      this.status.retrying = false;

      this.logger?.error("llm.request.failed", {
        requestId,
        status,
        error: errorMsg
      });
      throw err;
    }
  }

  async chatWithRetry(systemPrompt, userPrompt, requestId, model, options = {}) {
    let attempt = 0;
    const maxAttempts = this.config.maxRetries;

    while (true) {
      try {
        const temperature = Number.isFinite(options.temperature)
          ? options.temperature
          : this.config.temperature;
        const topP = Number.isFinite(options.topP)
          ? options.topP
          : this.config.topP;
        const maxTokens = Number.isFinite(options.maxTokens)
          ? options.maxTokens
          : this.config.maxTokens;
        const presencePenalty = Number.isFinite(options.presencePenalty)
          ? options.presencePenalty
          : this.config.presencePenalty;
        const frequencyPenalty = Number.isFinite(options.frequencyPenalty)
          ? options.frequencyPenalty
          : this.config.frequencyPenalty;
        const payload = {
          model: model || this.config.vllmModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature,
          top_p: topP,
          max_tokens: maxTokens
        };

        if (Number.isFinite(presencePenalty)) {
          payload.presence_penalty = presencePenalty;
        }
        if (Number.isFinite(frequencyPenalty)) {
          payload.frequency_penalty = frequencyPenalty;
        }

        if (options.extraBody && Object.keys(options.extraBody).length > 0) {
          payload.extra_body = options.extraBody;
        } else if (this.config.openaiExtraBody && Object.keys(this.config.openaiExtraBody).length > 0) {
          payload.extra_body = this.config.openaiExtraBody;
        }

        const response = await this.client.chat.completions.create(payload);

        if (!response || !response.choices || !response.choices[0] || !response.choices[0].message) {
          throw new Error("Unexpected LLM response format");
        }

        return {
          ...response.choices[0].message,
          usage: response.usage || null
        };
      } catch (err) {
        attempt += 1;
        const isRetryable = this.isRetryableError(err);

        if (!isRetryable || attempt > maxAttempts) {
          this.status.retrying = false;
          this.logger?.error("llm.request.failed", {
            requestId,
            attempt,
            isRetryable,
            error: err.message || String(err)
          });
          throw err;
        }

        const sleepSeconds = Math.min(
          this.config.retryMaxSeconds,
          this.config.retryBaseSeconds * Math.pow(this.config.retryBackoffMultiplier, attempt - 1)
            + Math.random() * this.config.retryJitterSeconds
        );

        this.status.retrying = true;
        this.status.last_retry_at = nowIso();
        this.status.last_retry_attempt = attempt;
        this.status.last_retry_error = err.message || String(err);

        this.logger?.warn("llm.request.retry", {
          requestId,
          attempt,
          sleepSeconds: sleepSeconds.toFixed(2),
          error: err.message || String(err)
        });

        await new Promise((resolve) => setTimeout(resolve, sleepSeconds * 1000));
      }
    }
  }

  isRetryableError(err) {
    if (!err) return false;
    const message = (err.message || "").toLowerCase();
    const status = err.status || err.statusCode || 0;
    const code = String(err.code || "").toUpperCase();

    const retryableStatus = status === 408 || status === 429 || (status >= 500 && status < 600);

    const retryableCodes = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE"
    ].includes(code);

    const retryableKeywords = [
      "timeout",
      "rate limit",
      "try again",
      "overloaded",
      "temporary",
      "connection",
      "socket",
      "network"
    ].some((kw) => message.includes(kw));

    return retryableStatus || retryableCodes || retryableKeywords;
  }

  normalizeBaseUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    return `http://${value}`;
  }
}

module.exports = { LlmClient };
