/* 用途：调用 vLLM OpenAI 兼容接口并带重试机制。
不负责：提示词构建或命令执行。
输入：系统/用户提示词与生成参数。
输出：模型响应文本，供后续解析。
关联：src/agent.js, src/config.js, src/logger.js。
*/

class LlmClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async chat(systemPrompt, userPrompt) {
    const baseUrl = this.normalizeBaseUrl(this.config.vllmBaseUrl);
    if (!baseUrl) {
      throw new Error("VLLM_BASE_URL is empty");
    }
    if (baseUrl !== this.config.vllmBaseUrl) {
      this.logger?.warn("llm.base_url.normalized", {
        before: this.config.vllmBaseUrl,
        after: baseUrl
      });
    }
    const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (this.config.vllmApiKey) {
      headers.Authorization = `Bearer ${this.config.vllmApiKey}`;
    }

    const payload = {
      model: this.config.vllmModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: this.config.temperature,
      top_p: this.config.topP,
      max_tokens: this.config.maxTokens
    };

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptChars = (systemPrompt?.length || 0) + (userPrompt?.length || 0);
    this.logger?.info("llm.request.start", { requestId, url, model: payload.model, promptChars });

    const response = await this.requestWithRetry(url, headers, payload, requestId);
    const data = await response.json();
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
      this.logger?.error("llm.response.invalid", { requestId, response: JSON.stringify(data) });
      throw new Error("Unexpected LLM response format");
    }
    this.logger?.info("llm.request.success", { requestId, status: response.status });
    return data.choices[0].message.content;
  }

  async requestWithRetry(url, headers, payload, requestId) {
    let attempt = 0;
    while (true) {
      try {
        const startAt = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000);
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (response.status < 400) {
          this.logger?.info("llm.request.end", { requestId, status: response.status, ms: Date.now() - startAt });
          return response;
        }
        if (response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600)) {
          throw new Error(`Retryable HTTP error ${response.status}`);
        }
        throw new Error(`HTTP error ${response.status}`);
      } catch (err) {
        attempt += 1;
        this.logger?.warn("llm.request.retry", { requestId, attempt, error: err.message || String(err) });
        if (attempt > this.config.maxRetries) {
          this.logger?.error("llm.request.failed", { requestId, attempt, error: err.message || String(err) });
          throw err;
        }
        const sleepSeconds = Math.min(
          this.config.retryMaxSeconds,
          this.config.retryBaseSeconds * Math.pow(this.config.retryBackoffMultiplier, attempt - 1)
            + Math.random() * this.config.retryJitterSeconds
        );
        await new Promise((resolve) => setTimeout(resolve, sleepSeconds * 1000));
      }
    }
  }

  normalizeBaseUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    return `http://${value}`;
  }
}

module.exports = { LlmClient };
