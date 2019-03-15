/**
 * TODO: create channels transparently when sending to `@` channels?
 * TODO: disable the `interval` to refreshState() since we should have all
 * RTM listeners in place now?
 */
module.exports = function(RED) {
  "use strict";

  const { RTMClient } = require("@slack/client");
  const { WebClient } = require("@slack/client");

  /**
   * https://nodered.org/docs/creating-nodes/status
   * The shape property can be: ring or dot
   * The fill property can be: red, green, yellow, blue or grey
   */
  var statuses = {
    connecting: { fill: "yellow", shape: "ring", text: "connecting" },
    connected: { fill: "green", shape: "dot", text: "connected" },
    disconnected: { fill: "red", shape: "ring", text: "disconnected" },
    misconfigured: { fill: "red", shape: "ring", text: "misconfigured" },
    error: { fill: "red", shape: "dot", text: "error" },
    sending: { fill: "blue", shape: "dot", text: "sending" },
    blank: {}
  };

  function SlackDebug() {
    var debug = process.env.SLACK_DEBUG ? true : false;
    if (!debug) {
      return;
    }

    // 16-5-2015 9:50:11
    var d = new Date();
    var datestring =
      d.getFullYear() +
      "-" +
      (d.getMonth() + 1) +
      "-" +
      d.getDate() +
      " " +
      d.getHours() +
      ":" +
      d.getMinutes() +
      ":" +
      d.getSeconds();
    var prefix = datestring + " - [debug] ";

    console.log(
      "---------------------------------------------------------------------"
    );
    console.log(prefix + "slack");
    if (arguments.length > 1) {
      arguments[0] = arguments[0] + "\n";
    }
    console.log(...arguments);
    console.log(
      "---------------------------------------------------------------------"
    );
  }

  /**
   * turn any value into a string
   * https://webbjocke.com/javascript-check-data-types/
   *
   * @param {*} value
   */
  function ValueToString(value) {
    if (value && typeof value === "object" && value.constructor === Array) {
      return JSON.stringify(value);
    }

    if (value && typeof value === "object" && value.constructor === Object) {
      return JSON.stringify(value);
    }

    /**
     * seeing some really weird cases where the above fail but "" + value
     * returns '[object Object]'
     */
    if (value && typeof value === "object") {
      return JSON.stringify(value);
    }

    if (value === null || typeof value === "undefined") {
      return "";
    }

    if (typeof value === "boolean") {
      if (value) {
        return "true";
      } else {
        return "false";
      }
    }

    if (typeof value === "number" && isFinite(value)) {
      return value.toString();
    }

    if (!!(value && value.constructor && value.call && value.apply)) {
      return value.toString();
    }

    return "" + value;
  }

  /**
   * Common event listeners to set status indicators
   *
   * @param {*} node
   */
  function SetConfigNodeConnectionListeners(node) {
    node.clientNode.rtmClient.on("connecting", () => {
      node.status(statuses.connecting);
    });

    node.clientNode.rtmClient.on("ready", () => {
      node.status(statuses.connected);
    });

    node.clientNode.rtmClient.on("disconnected", e => {
      var status = statuses.disconnected;

      /**
       * {
       *   code: 'slackclient_platform_error',
       *   data: { ok: false, error: 'invalid_auth' }
       * }
       */
      if (e.code == "slackclient_platform_error" && e.data.ok === false) {
        status.text = e.data.error;
      }

      node.status(status);
    });

    /**
     * if connectivity is dropped we go from connected -> reconnecting
     * directly bypassing disconnected
     */
    node.clientNode.rtmClient.on("reconnecting", () => {
      node.status(statuses.disconnected);
    });
  }

  /**
   * Slack client helper to recursively request a resource using pagination
   * https://slack.dev/node-slack-sdk/web_api#pagination
   *
   * @param {*} client
   * @param {*} method
   * @param {*} property
   * @param {*} options
   */
  function RecursivePaginatedWebCall(client, method, property, options = {}) {
    /**
     * store all entries
     */
    var data = [];

    /**
     * count of recursive calls required
     */
    var rcount = 0;

    return new Promise((resolve, reject) => {
      function recurse() {
        rcount++;
        client
          .apiCall(method, options)
          .then(res => {
            data = data.concat(res[property]);

            /**
             * if more pages, keep going otherwise resolve the promise
             */
            if (
              res.response_metadata &&
              res.response_metadata.next_cursor &&
              res.response_metadata.next_cursor !== ""
            ) {
              options.cursor = res.response_metadata.next_cursor;

              // keep recursing
              recurse();
            } else {
              resolve(data);
            }
          })
          .catch(e => {
            reject(e);
          });
      }

      // start recursion
      recurse();
    });
  }

  /**
   * Connection/configuration NODE for slack api
   * make note that when the flows are deployed this function will be
   * re-ran (along with other nodes)
   *
   * @param {*} n
   */
  function SlackConfig(n) {
    RED.nodes.createNode(this, n);

    var node = this;
    this.options = {};
    this.state = {};
    this.webClient = null;
    this.rtmClient = null;

    this.shortToken = function() {
      if (this.credentials && this.credentials.hasOwnProperty("token")) {
        var token = this.credentials.token;
        return token.substr(0, 8) + "..." + token.substr(token.length - 3);
      }
    };

    if (this.credentials && this.credentials.hasOwnProperty("token")) {
      /**
       * This can be used to pre-emptively valid API calls when check against
       * this scopes the user has
       *
       * https://api.slack.com/docs/token-types
       */
      var tokenType = null;
      if (this.credentials.token.startsWith("xoxp-")) {
        tokenType = "user";
      } else if (this.credentials.token.startsWith("xoxb-")) {
        tokenType = "bot";
      } else {
        // TODO: validate this on the config node
        tokenType = "invalid";
      }

      /**
       * meta method to refresh all state data
       */
      this.refreshState = function() {
        SlackDebug("refreshing state " + this.shortToken());
        var promises = [];
        promises.push(this.refreshTeam());
        promises.push(this.refreshChannels());
        promises.push(this.refreshMembers());
        promises.push(this.refreshBots());
        promises.push(this.refreshUser());
        promises.push(this.refreshDnd());

        return Promise.all(promises)
          .then(() => {
            this.emit("state_refreshed", {});
          })
          .catch(e => {
            this.error(e);
          });
      };

      /**
       * update local cache of channels
       */
      this.refreshChannels = function() {
        /**
         * TODO: ensure this does not happen too frequent
         * get all channels
         * https://api.slack.com/methods/conversations.list
         */
        return RecursivePaginatedWebCall(
          this.webClient,
          "conversations.list",
          "channels",
          {
            limit: 1000,
            exclude_archived: true,
            types: "public_channel,private_channel,im,mpim"
          }
        )
          .then(res => {
            var channels = {};
            res.forEach(item => {
              channels[item.id] = item;
            });
            this.state.channels = channels;
          })
          .catch(e => {
            this.error(e);
          });
      };

      /**
       * update local cache of members
       */
      this.refreshMembers = function() {
        /**
         * TODO: ensure this does not happen too frequent
         * get all members
         * https://api.slack.com/methods/users.list
         */
        return RecursivePaginatedWebCall(
          this.webClient,
          "users.list",
          "members",
          {
            limit: 1000
          }
        )
          .then(res => {
            this.state.presence = this.state.presence || {};
            var members = {};
            res.forEach(item => {
              members[item.id] = item;
            });
            this.state.members = members;
          })
          .catch(e => {
            this.error(e);
          });
      };

      /**
       * update local cache of bots
       */
      this.refreshBots = function() {
        var promises = [];
        this.state.bots = this.state.bots || {};

        for (var id in this.state.bots) {
          if (this.state.bots.hasOwnProperty(id)) {
            SlackDebug("webrequest to find bot: " + id);
            var p = this.webClient
              .apiCall("bots.info", { bot: id })
              .then(res => {
                this.state.bots[id] = res.bot;
              })
              .catch(e => {
                this.error(e);
              });

            promises.push(p);
          }
        }

        return Promise.all(promises)
          .then(() => {
            // TODO: update any internal flags?
          })
          .catch(e => {
            this.error(e);
          });
      };

      /**
       * update local cache of team
       */
      this.refreshTeam = function() {
        /**
         * TODO: ensure this does not happen too frequent
         * https://api.slack.com/methods/team.info
         */
        return this.webClient
          .apiCall("team.info")
          .then(res => {
            this.state.team = res.team;
          })
          .catch(e => {
            this.error(e);
          });
      };

      /**
       * update local cache of identity
       */
      this.refreshUser = function() {
        /**
         * TODO: ensure this does not happen too frequent
         * https://api.slack.com/methods/users.identity
         */
        if (this.state.connection.self.id) {
          return this.webClient
            .apiCall("users.identity", { user: this.state.connection.self.id })
            .then(res => {
              this.state.user = res.user;
            })
            .catch(e => {
              //this.error(e);
            });
        }
      };

      /**
       * update local cache of dnd
       */
      this.refreshDnd = function() {
        return this.webClient
          .apiCall("dnd.teamInfo")
          .then(res => {
            this.state.dnd = res.users;
          })
          .catch(e => {
            //this.error(e);
          });
      };

      /**
       * lookup member based off of id
       */
      this.findMemberById = function(id) {
        SlackDebug("looking up member: " + id);
        this.state.members = this.state.members || {};
        return this.state.members[id];
      };

      /**
       * lookup member based off of name or @name syntax
       */
      this.findMemberByName = function(name) {
        SlackDebug("looking up member: " + name);
        this.state.members = this.state.members || {};
        for (var id in this.state.members) {
          if (this.state.members.hasOwnProperty(id)) {
            if (
              this.state.members[id].deleted === false &&
              this.state.members[id].name == name.replace(/^@/, "")
            ) {
              return this.state.members[id];
            }
          }
        }
      };

      /**
       * lookup channel based off of id
       */
      this.findChannelById = function(id) {
        SlackDebug("looking up channel: " + id);
        this.state.channels = this.state.channels || {};
        return this.state.channels[id];
      };

      /**
       * channels start with:
       *  C - Conference (normal rooms)
       *  G - Group (multiuser, and private channels)
       *  D - Direct (user to user)
       */
      this.findChannelByName = function(name, type = null) {
        SlackDebug("looking up channel: " + name);
        this.state.channels = this.state.channels || {};

        /**
         * this purposely does a lookup on both regardless to handle
         * use-cases where the # or @ is ommitted completely
         */
        var directChannel = null;
        var roomChannel = null;

        // do lockup by member name
        var member = this.findMemberByName(name);
        if (member) {
          for (var id in this.state.channels) {
            if (this.state.channels.hasOwnProperty(id)) {
              if (
                this.state.channels[id].id[0] == "D" &&
                this.state.channels[id].is_user_deleted === false &&
                this.state.channels[id].user == member.id
              ) {
                directChannel = this.state.channels[id];
                break;
              }
            }
          }
        }

        // do lookup by channel name
        for (var id in this.state.channels) {
          if (this.state.channels.hasOwnProperty(id)) {
            if (
              this.state.channels[id].is_archived === false &&
              this.state.channels[id].name == name.replace(/^#/, "")
            ) {
              roomChannel = this.state.channels[id];
              break;
            }
          }
        }

        if (name[0] == "@") {
          return directChannel;
        } else if (name[0] == "#") {
          return roomChannel;
        } else {
          return directChannel || roomChannel;
        }
      };

      /**
       * lookup bot based off of id
       */
      this.findBotById = function(id) {
        SlackDebug("looking up bot: " + id);
        this.state.bots = this.state.bots || {};
        var bot = this.state.bots[id];

        if (!bot) {
          SlackDebug("webrequest to find bot: " + id);
          this.webClient
            .apiCall("bots.info", { bot: id })
            .then(res => {
              this.state.bots[id] = res.bot;
            })
            .catch(e => {
              //ignore
            });
        }

        return bot;
      };

      /**
       * Takes raw responses from RTM/Web API and adds additional properties
       * to help looking up names/etc as msg flows through nodered
       */
      this.dressResponseMessage = function(res) {
        var node = this;
        var depth = 0;
        function recurse(data) {
          depth++;
          for (var key in data) {
            if (data.hasOwnProperty(key)) {
              var value = data[key];

              /**
               * prevent infinite recursion by only going 2 deep
               */
              if (typeof value === "object" && depth < 2) {
                recurse(value);
                continue;
              }

              /**
               * dress users, channels, teams, etc
               */
              if (key.includes("user")) {
                if (typeof value === "string" || value instanceof String) {
                  if (!data.hasOwnProperty(key + "Object")) {
                    var member = node.findMemberById(value);
                    if (member) {
                      data[key + "Object"] = member;
                    }
                  }
                }
              } else if (key.includes("channel")) {
                if (typeof value === "string" || value instanceof String) {
                  if (!data.hasOwnProperty(key + "Object")) {
                    var channel = node.findChannelById(value);
                    if (channel) {
                      data[key + "Object"] = channel;
                    }
                  }
                }
              } else if (key.includes("team")) {
                if (typeof value === "string" || value instanceof String) {
                  if (!data.hasOwnProperty(key + "Object")) {
                    if (value == node.state.team.id)
                      data[key + "Object"] = node.state.team;
                  }
                }
              } else if (key.includes("bot")) {
                if (typeof value === "string" || value instanceof String) {
                  if (!data.hasOwnProperty(key + "Object")) {
                    var bot = node.findBotById(value);
                    if (bot) {
                      data[key + "Object"] = bot;
                    }
                  }
                }
              }
            }
          }

          --depth;
        }

        try {
          recurse(res);
        } catch (e) {
          node.error(e);
        }

        return res;
      };

      /**
       * https://api.slack.com/methods
       * https://slack.dev/node-slack-sdk/web_api
       * https://github.com/slackapi/node-slack-sdk/blob/master/src/WebClient.ts
       */
      this.webClient = new WebClient(this.credentials.token);

      /**
       * https://slack.dev/node-slack-sdk/rtm_api
       * https://slack.dev/node-slack-sdk/rtm_api#lifecycle-events
       * https://api.slack.com/rtm#events
       * https://github.com/slackapi/node-slack-sdk/blob/master/src/RTMClient.ts
       *
       * by default autoReconnect=true and keepAlive settings are enabled
       */
      this.rtmClient = new RTMClient(this.credentials.token, {
        logLevel: process.env.SLACK_DEBUG ? "debug" : "info",
        retryConfig: {
          forever: true,
          minTimeout: 1 * 1000,
          maxTimeout: 5 * 1000
        }
      });

      this.rtmClient.on("disconnected", e => {
        SlackDebug("disconnected " + this.shortToken(), e);
        this.log(
          RED._("node-red:common.status.disconnected") +
            " from slack with token: " +
            this.shortToken()
        );
        clearInterval(this.refreshIntervalId);
      });

      this.rtmClient.on("connecting", () => {
        SlackDebug("connecting " + this.shortToken());
        clearInterval(this.refreshIntervalId);
      });

      this.rtmClient.on("authenticated", () => {
        SlackDebug("authenticated " + this.shortToken());
      });

      this.rtmClient.on("connected", () => {
        SlackDebug("connected " + this.shortToken());
        this.log(
          RED._("node-red:common.status.connected") +
            " to slack with token: " +
            this.shortToken()
        );
        // what is worse, no data or potentially stale data?
        this.state.presence = {};

        this.refreshState()
          .then(() => {
            this.emit("state_initialized", {});
          })
          .catch(e => {
            this.error(e);
          });

        // TODO: make this a node configurable item
        var interval = 10 * 60 * 1000;
        this.refreshIntervalId = setInterval(function() {
          node.refreshState();
        }, interval);

        this.on("close", () => {
          clearInterval(this.refreshIntervalId);
        });
      });

      this.rtmClient.on("ready", () => {
        SlackDebug("ready " + this.shortToken());
      });

      this.rtmClient.on("disconnecting", () => {
        SlackDebug("disconnecting " + this.shortToken());
        clearInterval(this.refreshIntervalId);
      });

      /**
       * if connectivity is dropped we go from connected -> reconnecting
       * directly bypassing disconnected
       */
      this.rtmClient.on("reconnecting", () => {
        SlackDebug("reconnecting " + this.shortToken());
        this.log(
          RED._("node-red:common.status.disconnected") +
            " from slack with token: " +
            this.shortToken()
        );
        clearInterval(this.refreshIntervalId);
      });

      this.rtmClient.on("error", e => {
        SlackDebug("error " + this.shortToken(), e);
      });

      this.rtmClient.on("unable_to_rtm_start", e => {
        SlackDebug("unable_to_rtm_start " + this.shortToken(), e);
      });

      /**
       * This is meant to keep state current
       *  - bots
       *  - members
       *  - channels
       *  - team
       *  - dnd
       *  - presence (only listen to what the user has subscribed to manually)
       */
      this.rtmClient.on("slack_event", (eventType, event) => {
        switch (eventType) {
          case "user_change":
          case "team_join":
            this.state.members = this.state.members || {};
            this.state.members[event.user.id] = event.user;
            break;
          case "bot_added":
          case "bot_changed":
            this.state.bots = this.state.bots || {};
            this.state.bots[event.bot.id] = event.bot;
            break;
          case "channel_deleted":
          case "group_deleted":
            this.state.channels = this.state.channels || {};
            delete this.state.channels[event.channel];
            break;
          case "channel_created":
          case "channel_joined":
          case "channel_rename":
          case "group_joined":
          case "group_rename":
          case "im_created":
            this.webClient
              .apiCall("channels.info", { channel: event.channel.id })
              .then(res => {
                this.state.channels = this.state.channels || {};
                this.state.channels[res.channel.id] = res.channel;
              })
              .catch(e => {
                console.log("failed getting channel info", e);
              });
            break;
          case "channel_archive":
          case "channel_left":
          case "channel_unarchive":
          case "group_archive":
          case "group_close":
          case "group_left":
          case "group_open":
          case "group_unarchive":
          case "im_close":
          case "im_open":
          case "member_joined_channel":
          case "member_left_channel":
            this.webClient
              .apiCall("channels.info", { channel: event.channel })
              .then(res => {
                this.state.channels = this.state.channels || {};
                this.state.channels[res.channel.id] = res.channel;
              })
              .catch(e => {
                console.log("failed getting channel info", e);
              });
            break;
          case "presence_change":
            this.state.presence = this.state.presence || {};
            if (event.user) {
              var res = {
                type: event.type,
                presence: event.presence,
                user: event.user
              };
              this.state.presence[event.user] = res;
            }

            if (event.users) {
              event.users.forEach(user => {
                var res = {
                  type: event.type,
                  presence: event.presence,
                  user: user
                };
                this.state.presence[user] = res;
              });
            }
            break;
          case "manual_presence_change":
            this.state.presence = this.state.presence || {};
            this.this.state.presence[this.state.connection.self.id] = {
              type: event.type,
              presence: event.presence,
              user: this.state.connection.self.id
            };
            break;
          case "dnd_updated":
          case "dnd_updated_user":
            this.state.dnd = this.state.dnd || {};
            this.state.dnd[event.user] = event.dnd_status;
            break;
          case "team_rename":
          case "team_domain_change":
          case "team_plan_change":
          case "team_pref_change":
          case "team_profile_change":
          case "team_profile_delete":
          case "team_profile_reorder":
            this.webClient
              .apiCall("team.info")
              .then(res => {
                this.state.team = res.team;
              })
              .catch(e => {
                console.log("failed getting team info", e);
              });
            break;
          default:
            // do nothing
            break;
        }
      });

      this.startClient = function() {
        /**
         * may consider using the .connect() method instead
         * https://api.slack.com/methods/rtm.start
         * https://api.slack.com/methods/rtm.connect
         */
        this.rtmClient
          .start()
          .then(res => {
            SlackDebug("start result " + this.shortToken(), res);
            this.state.connection = {};
            this.state.connection.self = res.self;
            this.state.connection.url = res.url;
            this.state.connection.scopes = res.scopes;
            this.state.connection.acceptedScopes = res.acceptedScopes;
          })
          .catch(e => {
            console.log("failed starting slack session", e);
          });
      };
      this.startClient();

      //start watchdog
      this.connectionWatchdog = function() {
        //var interval = (5 * 60 * 1000);
        var interval = 15 * 1000;
        var lastState = null;
        var stateAt = null;
        var maxUnconnectedStateSeconds = 30;
        var intervalId = setInterval(() => {
          SlackDebug("watchdog connection details", {
            connected: this.rtmClient.connected,
            currentState: this.rtmClient.stateMachine.getCurrentState(),
            currentStateAt: stateAt
          });

          if (lastState === null) {
            lastState = this.rtmClient.stateMachine.getCurrentState();
            stateAt = Date.now();
          }

          if (
            !this.rtmClient.connected &&
            lastState == this.rtmClient.stateMachine.getCurrentState() &&
            (Date.now() - stateAt) / 1000 > maxUnconnectedStateSeconds
          ) {
            console.log(
              "sitting in " +
                lastState +
                " for longer than " +
                maxUnconnectedStateSeconds +
                " seconds"
            );
            //console.log("slack watchdog attempting to force reconnect");
            //console.log(this.rtmClient);
          }

          if (lastState != this.rtmClient.stateMachine.getCurrentState()) {
            stateAt = Date.now();
          }
          lastState = this.rtmClient.stateMachine.getCurrentState();
        }, interval);

        this.on("close", () => {
          clearInterval(intervalId);
        });
      };
      //this.connectionWatchdog();

      this.on("close", done => {
        /**
         * attempt a disconnect regardless of current state
         * and simply catch invalid transitions etc
         */
        this.rtmClient
          .disconnect()
          .then(() => {
            this.rtmClient.removeAllListeners();
            done();
          })
          .catch(e => {
            done();
          });
      });
    }
  }
  RED.nodes.registerType("slack-config", SlackConfig, {
    credentials: {
      token: { type: "text" }
    }
  });

  /**
   * Send the current state of the config object out
   *
   * @param {*} n
   */
  function SlackState(n) {
    RED.nodes.createNode(this, n);

    var node = this;
    this.client = n.client;
    this.clientNode = RED.nodes.getNode(this.client);

    node.status(statuses.disconnected);

    if (node.client) {
      SetConfigNodeConnectionListeners(node);

      node.on("input", function(msg) {
        SlackDebug("slack-state incomiming message", msg);

        node.status(statuses.sending);

        /**
         * support for forcing a refresh of data
         */
        if (msg.payload === true) {
          node.clientNode
            .refreshState()
            .then(() => {
              msg.slackState = node.clientNode.state;
              node.send(msg);
              node.status(statuses.connected);
            })
            .catch(e => {
              SlackDebug("slack-state error response", e.data);
              msg.payload = e.data;
              node.send(msg);
              node.status(statuses.connected);
            });
        } else {
          msg.slackState = node.clientNode.state;
          node.send(msg);
          node.status(statuses.connected);
        }
      });

      ["state_initialized"].forEach(eventName => {
        node.clientNode.on(eventName, e => {
          node.status(statuses.sending);
          var msg = {};

          switch (eventName) {
            case "state_initialized":
              eventName = "ready";
              break;
          }

          msg.slackState = node.clientNode.state;
          msg.payload = {
            type: eventName
          };
          node.send([null, msg]);
          node.status(statuses.connected);
        });
      });
    } else {
      node.status(statuses.misconfigured);
    }
  }
  RED.nodes.registerType("slack-state", SlackState);

  /**
   * Read all 'slack_events' from the slack RTM api
   * https://api.slack.com/rtm#events
   *
   * @param {*} n
   */
  function SlackRtmIn(n) {
    RED.nodes.createNode(this, n);

    var node = this;
    this.client = n.client;
    this.events = n.events;
    this.clientNode = RED.nodes.getNode(this.client);

    var eventNames;
    if (this.events) {
      eventNames = this.events
        .replace(/[\s]+/g, "")
        .split(",")
        .filter(Boolean);
    }

    node.status(statuses.disconnected);

    if (node.client) {
      SetConfigNodeConnectionListeners(node);

      node.clientNode.rtmClient.on("slack_event", (eventType, event) => {
        /**
         * responses to websocket commands come over the without an eventType
         */
        if (eventType === undefined) {
          eventType = "ws_response";
          event.type = eventType;
        }

        /**
         * ignore non-subscribed events
         * 
         * Since the message events are bound to the same object as connection
         * events this feature has been implemented in this fashion vs directly
         * subscribing to prevent stupid (ie: someone setting a value of
         * 'connected' or the like) in node properties. Crude but effective.
         * 
         * It also decouples the feature from the semantics of the client.
         */
        if (this.events && eventNames.length > 0) {
          if (
            !(
              eventNames.includes(event.type) ||
              (event.subtype &&
                eventNames.includes(`${event.type}::${event.subtype}`))
            )
          ) {
            return null;
          }
        }

        /**
         * pong: triggered in response to a ping keep-alive
         *
         * hello: triggered on connect
         *
         * ws_response: triggered after data has been sent over the ws
         *
         * channel_marked: triggered when the bot user has 'read' a channel
         *
         * desktop_notification: triggered when the bot user is @mentioned or
         * otherwise would receive an alert
         *
         * pretty sure nobody is interested in the below
         * note that ws_response is sent on the output side of the output node
         * so receiving it here is double processing
         */
        if (eventType == "pong" || eventType == "ws_response") {
          return null;
        }

        SlackDebug("slack-rtm-in incoming event", event);
        var msg = {};
        msg.payload = node.clientNode.dressResponseMessage(event);
        msg.slackState = node.clientNode.state;
        node.send(msg);
      });
    } else {
      node.status(statuses.misconfigured);
    }
  }
  RED.nodes.registerType("slack-rtm-in", SlackRtmIn);

  /**
   * Write to the slack RTM api
   * https://api.slack.com/rtm
   * https://slack.dev/node-slack-sdk/rtm_api
   *
   * @param {*} n
   */
  function SlackRtmOut(n) {
    RED.nodes.createNode(this, n);

    var node = this;
    this.client = n.client;
    this.clientNode = RED.nodes.getNode(this.client);

    node.status(statuses.disconnected);

    if (node.client) {
      SetConfigNodeConnectionListeners(node);

      node.on("input", function(msg) {
        SlackDebug("slack-rtm-out incomiming message", msg);

        /**
         * message, presence_sub, presence_query, ping, and typing.
         */
        var method = msg.topic;
        var options = msg.payload;

        if (
          !method ||
          typeof method !== "string" ||
          !method instanceof String
        ) {
          node.error("invalid msg.topic");
          return null;
        }

        /**
         * Try to help with common use case, set channel based on lookup if starts with @ or #
         */
        if (
          method == "message" &&
          (options.channel[0] == "@" || options.channel[0] == "#")
        ) {
          var channel = node.clientNode.findChannelByName(options.channel);
          if (channel && channel.id) {
            options.channel = channel.id;
          }
        }

        /**
         * special handling for simple use-case
         */
        if (method[0] == "@" || method[0] == "#") {
          var channel = node.clientNode.findChannelByName(method);
          if (!channel || !channel.id) {
            node.error("invalid channel: " + method);
            return null;
          }
          method = "message";
          options = {
            text: msg.payload,
            channel: channel.id
          };
        }

        /**
         * custom per-method logic
         */
        switch (method) {
          case "message":
            // force text to be a string
            options.text = ValueToString(options.text);
            break;
        }

        /**
         * something seems to block when it's not message events
         * keeping a hard-coded list for now until the 'bug' is squashed
         *
         * https://github.com/slackapi/node-slack-sdk/issues/706
         *
         * There's only 5 (public) writable events on RTM: message,
         * presence_sub, presence_query, ping, and typing.
         *
         * The only two that expect responses are message and ping.
         */
        var awaitReply = false;
        switch (method) {
          case "message":
          case "ping":
            awaitReply = true;
            break;
          case "presence_sub":
          case "presence_query":
          case "typing":
            awaitReply = false;
            break;
          default:
            /**
             * go ahead and let invalid methods await so a negative/error
             * response is returned
             */
            awaitReply = true;
            break;
        }

        node.status(statuses.sending);
        msg.slackState = node.clientNode.state;

        SlackDebug("slack-rtm-out call", method, options);
        node.clientNode.rtmClient
          .addOutgoingEvent(awaitReply, method, options)
          .then(res => {
            /**
             * mock a response for methods which return nothing
             * ie: everything but message and ping
             */
            if (typeof res === "undefined") {
              res = {
                ok: true,
                type: method
              };
            }

            SlackDebug("slack-rtm-out call response", res);
            msg.payload = res;
            node.send(msg);
            node.status(statuses.connected);
          })
          .catch(e => {
            SlackDebug("slack-rtm-out error response", e.data);
            msg.payload = e.data;
            node.send(msg);
            node.status(statuses.connected);
          });
      });
    } else {
      node.status(statuses.misconfigured);
    }
  }
  RED.nodes.registerType("slack-rtm-out", SlackRtmOut);

  /**
   * Interact with the slack web/REST api
   * https://api.slack.com/methods
   * https://slack.dev/node-slack-sdk/web_api
   *
   * @param {*} n
   */
  function SlackWebOut(n) {
    RED.nodes.createNode(this, n);

    var node = this;
    this.client = n.client;
    this.clientNode = RED.nodes.getNode(this.client);

    node.status(statuses.disconnected);

    if (node.client) {
      SetConfigNodeConnectionListeners(node);

      node.on("input", function(msg) {
        SlackDebug("slack-web-out incomiming message", msg);

        var method = msg.topic;
        var options = msg.payload;

        if (
          !method ||
          typeof method !== "string" ||
          !method instanceof String
        ) {
          node.error("invalid msg.topic");
          return null;
        }

        /**
         * Try to help with common use case, set channel based on lookup if starts with @ or #
         *
         * https://api.slack.com/methods/chat.postMessage
         */
        if (
          method == "chat.postMessage" ||
          method == "chat.postEphemeral" ||
          method == "chat.meMessage"
        ) {
          if (options.channel[0] == "@" || options.channel[0] == "#") {
            var channel = node.clientNode.findChannelByName(options.channel);
            if (channel && channel.id) {
              options.channel = channel.id;
            }
          }
        }

        /**
         * special handling for simple use-case
         */
        if (method[0] == "@" || method[0] == "#") {
          var channel = node.clientNode.findChannelByName(method);
          if (!channel || !channel.id) {
            node.error("invalid channel: " + method);
            return null;
          }
          method = "chat.postMessage";
          options = {
            channel: channel.id,
            text: msg.payload
            //as_user: true
          };
        }

        /**
         * custom per-method logic
         */
        switch (method) {
          case "chat.postMessage":
          case "chat.postEphemeral":
          case "chat.meMessage":
            // force text to be a string
            options.text = ValueToString(options.text);
            break;
        }

        node.status(statuses.sending);
        msg.slackState = node.clientNode.state;

        SlackDebug("slack-web-out call", method, options);
        node.clientNode.webClient
          .apiCall(method, options)
          .then(res => {
            SlackDebug("slack-web-out call response", res);
            msg.payload = node.clientNode.dressResponseMessage(res);
            node.send(msg);
            node.status(statuses.connected);
          })
          .catch(e => {
            SlackDebug("slack-web-out error response", e.data);
            msg.payload = e.data;
            node.send(msg);
            node.status(statuses.connected);
          });
      });
    } else {
      node.status(statuses.misconfigured);
    }
  }
  RED.nodes.registerType("slack-web-out", SlackWebOut);
};
