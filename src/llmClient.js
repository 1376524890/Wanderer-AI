/* 用途：调用 vLLM OpenAI 兼容接口并带重试机制。
不负责：提示词构建或命令执行。
输入：系统/用户提示词与生成参数。
输出：模型响应文本，供后续解析。
关联：src/agent.js, src/config.js。
*/

class LlmClient {
  constructor(config) {
    this.config = config;
  }

  async chat(systemPrompt, userPrompt) {
    const url = `${this.config.vllmBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;
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

    const response = await this.requestWithRetry(url, headers, payload);
    const data = await response.json();
    if (!data || !data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error(`Unexpected LLM response format: ${JSON.stringify(data)}`);
    }
    return data.choices[0].message.content;
  }

  async requestWithRetry(url, headers, payload) {
    let attempt = 0;
    while (true) {
      try {
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
          return response;
        }
        if (response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600)) {
          throw new Error(`Retryable HTTP error ${response.status}`);
        }
        throw new Error(`HTTP error ${response.status}`);
      } catch (err) {
        attempt += 1;
        if (attempt > this.config.maxRetries) {
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
}

module.exports = { LlmClient };
