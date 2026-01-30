/* 用途：调用 OpenAI 兼容接口（zhipu 或 vLLM）并带重试机制。
不负责：提示词构建或命令执行。
输入：系统/用户提示词与生成参数。
输出：模型响应文本，供后续解析。
关联：src/agent.js, src/config.js, src/logger.js。
*/

const OpenAI = require("openai");

class LlmClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = this.createClient();
  }

  createClient() {
    const baseUrl = this.normalizeBaseUrl(this.config.vllmBaseUrl);
    if (!baseUrl) {
      throw new Error("VLLM_BASE_URL is empty");
    }
    const isLocalVllm = this.isLocalAddress(baseUrl);
    const apiKey = this.config.vllmApiKey || (isLocalVllm ? "EMPTY" : "");

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

  async chat(systemPrompt, userPrompt) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptChars = (systemPrompt?.length || 0) + (userPrompt?.length || 0);
    const model = this.config.vllmModel;

    this.logger?.info("llm.request.start", {
      requestId,
      model,
      promptChars,
      isLocalVllm: this.isLocalAddress(this.config.vllmBaseUrl)
    });

    try {
      const startAt = Date.now();
      const response = await this.chatWithRetry(systemPrompt, userPrompt, requestId);
      const ms = Date.now() - startAt;

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
      this.logger?.error("llm.request.failed", {
        requestId,
        error: err.message || String(err)
      });
      throw err;
    }
  }

  async chatWithRetry(systemPrompt, userPrompt, requestId) {
    let attempt = 0;
    const maxAttempts = this.config.maxRetries;

    while (true) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.config.vllmModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: this.config.temperature,
          top_p: this.config.topP,
          max_tokens: this.config.maxTokens
        });

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
    const message = err.message || "";
    const status = err.status || err.statusCode || 0;

    const retryableStatus = [408, 429].includes(status) ||
      (status >= 500 && status < 600);

    const retryableKeywords = [
      "timeout",
      "rate limit",
      "try again",
      "overloaded",
      "temporary",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED"
    ].some((kw) => message.toLowerCase().includes(kw));

    return retryableStatus || retryableKeywords;
  }

  normalizeBaseUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    return `http://${value}`;
  }
}

module.exports = { LlmClient };
