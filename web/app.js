const { createApp, ref, computed, nextTick, onMounted } = Vue;

createApp({
  setup() {
    const entries = ref([]);
    const status = ref({});
    const identities = ref({ identityA: "", identityB: "" });
    const experience = ref("");
    const connection = ref({ state: "connecting", lastEventAt: null });
    const autoScroll = ref(true);
    const autoPage = ref(true);
    const filterText = ref("");
    const hasMore = ref(false);
    const loadingEarlier = ref(false);
    const listRef = ref(null);

    let eventSource = null;
    let retryDelay = 1000;
    let lastEntryId = 0;

    const statusTime = computed(() => {
      if (!status.value.server_time) return "-";
      try {
        return new Date(status.value.server_time).toLocaleString();
      } catch (err) {
        return status.value.server_time;
      }
    });

    const connectionLabel = computed(() => {
      if (connection.value.state === "connected") return "已连接";
      if (connection.value.state === "reconnecting") return "重连中";
      return "连接中";
    });

    const apiStatusLabel = computed(() => {
      if (status.value.api_status?.retrying) return "RETRY";
      return status.value.api_status?.ok ? "OK" : "FAIL";
    });

    const apiStatusClass = computed(() => {
      if (status.value.api_status?.retrying) return "retry";
      return status.value.api_status?.ok ? "ok" : "fail";
    });

    const lastError = computed(() => {
      return (
        status.value.last_error ||
        status.value.api_status?.last_error ||
        ""
      );
    });

    const promptInfo = computed(() => status.value.prompt_info || {});

    const promptState = computed(() => {
      const info = promptInfo.value;
      if (!info.total_chars) return "";
      if (info.max_chars && info.total_chars >= info.max_chars) return "fail";
      if (info.warn_chars && info.total_chars >= info.warn_chars) return "warn";
      return "ok";
    });

    const promptTotalLabel = computed(() => {
      const info = promptInfo.value;
      if (!info.total_chars) return "-";
      const max = info.max_chars ? formatNumber(info.max_chars) : "-";
      return `${formatNumber(info.total_chars)} / ${max}`;
    });

    const promptBreakdown = computed(() => {
      const info = promptInfo.value;
      if (!info.total_chars) return "";
      const systemChars = info.system_chars ? formatNumber(info.system_chars) : "-";
      const userChars = info.user_chars ? formatNumber(info.user_chars) : "-";
      const trimmed = info.trimmed ? "已压缩" : "未压缩";
      return `system ${systemChars} · user ${userChars} · ${trimmed}`;
    });

    const filteredEntries = computed(() => {
      const keyword = filterText.value.trim().toLowerCase();
      if (!keyword) return entries.value;
      
      return entries.value.filter((entry) => {
        const haystack = [
          entry.title,
          entry.topic,
          entry.body,
          entry.timestamp,
          entry.agent
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(keyword);
      });
    });

    function isAtBottom() {
      const el = listRef.value;
      if (!el) return true;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    }

    function scrollToBottom() {
      const el = listRef.value;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    }

    async function loadEarlier() {
      if (loadingEarlier.value || !hasMore.value) return;
      if (!entries.value.length) return;
      const firstId = entries.value[0].id;
      if (!firstId) return;

      loadingEarlier.value = true;
      const el = listRef.value;
      const previousHeight = el ? el.scrollHeight : 0;

      try {
        const resp = await fetch(`/api/conversation?before=${firstId}&limit=50`);
        if (!resp.ok) throw new Error("load failed");
        const data = await resp.json();
        if (Array.isArray(data.entries) && data.entries.length) {
          entries.value = [...data.entries, ...entries.value];
          hasMore.value = Boolean(data.hasMore);
          await nextTick();
          if (el) {
            const newHeight = el.scrollHeight;
            el.scrollTop = newHeight - previousHeight + el.scrollTop;
          }
        } else {
          hasMore.value = Boolean(data.hasMore);
        }
      } catch (err) {
        // ignore UI fetch errors
      } finally {
        loadingEarlier.value = false;
      }
    }

    function onScroll() {
      const el = listRef.value;
      if (!el) return;
      if (autoPage.value && el.scrollTop <= 60) {
        loadEarlier();
      }
    }

    function applyEntries(newEntries, append = true) {
      if (!Array.isArray(newEntries) || !newEntries.length) return;
      const shouldStick = autoScroll.value && isAtBottom();
      
      if (append) {
        entries.value = [...entries.value, ...newEntries];
      } else {
        entries.value = newEntries;
      }
      
      if (entries.value.length > 30) {
        entries.value = entries.value.slice(-30);
      }
      
      nextTick(() => {
        if (shouldStick) scrollToBottom();
      });
    }

    function connectStream() {
      if (eventSource) eventSource.close();
      connection.value.state = "connecting";

      eventSource = new EventSource("/api/stream");
      eventSource.onopen = () => {
        connection.value.state = "connected";
        retryDelay = 1000;
      };

      eventSource.onerror = () => {
        connection.value.state = "reconnecting";
        eventSource.close();
        setTimeout(connectStream, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      };

      eventSource.addEventListener("snapshot", (evt) => {
        try {
          const data = JSON.parse(evt.data || "{}");
          status.value = data.status || {};
          identities.value = data.identities || { identityA: "", identityB: "" };
          experience.value = data.experience?.experience || "";
          
          const snapshotEntries = Array.isArray(data.entries) ? data.entries : [];
          entries.value = snapshotEntries.slice(-30);
          
          lastEntryId = data.lastEntryId || entries.value.length;
          hasMore.value = Boolean(data.hasMore);
          nextTick(scrollToBottom);
        } catch (err) {
          // ignore
        }
      });

      eventSource.addEventListener("status", (evt) => {
        try {
          const newStatus = JSON.parse(evt.data || "{}");
          status.value = newStatus;
        } catch (err) {
          // ignore
        }
      });

      eventSource.addEventListener("identities", (evt) => {
        try {
          identities.value = JSON.parse(evt.data || "{}");
        } catch (err) {
          // ignore
        }
      });

      eventSource.addEventListener("experience", (evt) => {
        try {
          experience.value = JSON.parse(evt.data || "{}").experience || "";
        } catch (err) {
          // ignore
        }
      });

      eventSource.addEventListener("entries", (evt) => {
        try {
          const data = JSON.parse(evt.data || "{}");
          if (data.reset) {
            entries.value = Array.isArray(data.entries) ? data.entries : [];
            hasMore.value = Boolean(data.hasMore);
            lastEntryId = data.lastEntryId || entries.value.length;
            nextTick(scrollToBottom);
            return;
          }
          if (Array.isArray(data.entries) && data.entries.length) {
            applyEntries(data.entries, true);
            lastEntryId = data.lastEntryId || lastEntryId;
          }
        } catch (err) {
          // ignore
        }
      });
    }

    async function refreshOnce() {
      try {
        const [statusResp, identityResp] = await Promise.all([
          fetch("/api/status"),
          fetch("/api/identities")
        ]);
        if (statusResp.ok) {
          status.value = await statusResp.json();
        }
        if (identityResp.ok) {
          identities.value = await identityResp.json();
        }
      } catch (err) {
        // ignore
      }
    }

    function formatNumber(value) {
      const num = Number(value || 0);
      if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
      if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
      return String(num);
    }

    function formatReward(signal) {
      if (!signal) return "-";
      const reward = Number(signal.reward || 0);
      const penalty = Number(signal.penalty || 0);
      const total = reward - penalty;
      return Number.isFinite(total) ? total.toFixed(2) : "-";
    }

    function formatPercent(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return "-";
      return `${Math.round(num * 100)}%`;
    }

    function formatSkill(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return "-";
      return num.toFixed(2);
    }

    onMounted(() => {
      connectStream();
    });

    return {
      entries,
      status,
      identities,
      experience,
      connection,
      autoScroll,
      autoPage,
      filterText,
      hasMore,
      loadingEarlier,
      listRef,
      statusTime,
      connectionLabel,
      apiStatusLabel,
      apiStatusClass,
      lastError,
      promptInfo,
      promptState,
      promptTotalLabel,
      promptBreakdown,
      filteredEntries,
      scrollToBottom,
      loadEarlier,
      onScroll,
      refreshOnce,
      formatNumber,
      formatReward,
      formatPercent,
      formatSkill
    };
  }
}).mount("#app");
