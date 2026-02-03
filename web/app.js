const { createApp, ref, computed, nextTick, onMounted } = Vue;

createApp({
  setup() {
    const entries = ref([]);
    const archivedTopics = ref([]);
    const currentTopic = ref("");
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

    const filteredEntries = computed(() => {
      let result = entries.value.filter(entry => entry.topic === currentTopic.value);
      
      const keyword = filterText.value.trim().toLowerCase();
      if (!keyword) return result;
      
      return result.filter((entry) => {
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
      
      const firstEntry = newEntries[0];
      if (firstEntry.topic && firstEntry.topic !== currentTopic.value) {
        if (currentTopic.value && entries.value.length > 0) {
          const topicEntries = entries.value.filter(e => e.topic === currentTopic.value);
          if (topicEntries.length > 0) {
            archivedTopics.value.push({
              topic: currentTopic.value,
              entries: topicEntries,
              archivedAt: new Date().toISOString()
            });
          }
        }
        currentTopic.value = firstEntry.topic;
        entries.value = newEntries.filter(e => e.topic === currentTopic.value);
      } else if (append) {
        entries.value = [...entries.value, ...newEntries];
      } else {
        entries.value = newEntries;
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
          const snapshotTopic = snapshotEntries.length > 0 ? snapshotEntries[snapshotEntries.length - 1].topic : "";
          
          if (snapshotTopic && snapshotTopic !== currentTopic.value) {
            if (currentTopic.value && entries.value.length > 0) {
              const topicEntries = entries.value.filter(e => e.topic === currentTopic.value);
              if (topicEntries.length > 0) {
                archivedTopics.value.push({
                  topic: currentTopic.value,
                  entries: topicEntries,
                  archivedAt: new Date().toISOString()
                });
              }
            }
            currentTopic.value = snapshotTopic;
            entries.value = snapshotEntries.filter(e => e.topic === currentTopic.value);
          } else {
            entries.value = snapshotEntries.filter(e => !currentTopic.value || e.topic === currentTopic.value);
          }
          
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
          
          if (newStatus.topic && newStatus.topic !== currentTopic.value && currentTopic.value) {
            const topicEntries = entries.value.filter(e => e.topic === currentTopic.value);
            if (topicEntries.length > 0) {
              archivedTopics.value.push({
                topic: currentTopic.value,
                entries: topicEntries,
                archivedAt: new Date().toISOString()
              });
            }
            currentTopic.value = newStatus.topic;
            entries.value = entries.value.filter(e => e.topic === currentTopic.value);
          }
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

    function switchTopic(topic) {
      if (topic === currentTopic.value) return;
      
      const existing = archivedTopics.value.find(a => a.topic === topic);
      if (existing) {
        if (currentTopic.value) {
          const currentEntries = entries.value.filter(e => e.topic === currentTopic.value);
          const archived = archivedTopics.value.findIndex(a => a.topic === currentTopic.value);
          if (archived >= 0) {
            archivedTopics.value[archived].entries = currentEntries;
          } else {
            archivedTopics.value.push({
              topic: currentTopic.value,
              entries: currentEntries,
              archivedAt: new Date().toISOString()
            });
          }
        }
        currentTopic.value = topic;
        entries.value = existing.entries;
      } else if (status.value.topic === topic) {
        if (currentTopic.value) {
          const currentEntries = entries.value.filter(e => e.topic === currentTopic.value);
          const archived = archivedTopics.value.findIndex(a => a.topic === currentTopic.value);
          if (archived >= 0) {
            archivedTopics.value[archived].entries = currentEntries;
          } else {
            archivedTopics.value.push({
              topic: currentTopic.value,
              entries: currentEntries,
              archivedAt: new Date().toISOString()
            });
          }
        }
        currentTopic.value = topic;
        entries.value = entries.value.filter(e => e.topic === topic);
      }
    }

    onMounted(() => {
      connectStream();
    });

    return {
      entries,
      archivedTopics,
      currentTopic,
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
      filteredEntries,
      scrollToBottom,
      loadEarlier,
      onScroll,
      refreshOnce,
      formatNumber,
      switchTopic
    };
  }
}).mount("#app");
