/**
 * Copyright 2015 Adrian Lansdown
 * Not created by, affiliated with, or supported by Slack Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

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

    node.clientNode.rtmClient.on("disconnected", () => {
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

        return Promise.all(promises)
          .then(() => {
            // TODO: update any internal flags?
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
         * TODO: ensure this does not happen to frequent
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
            this.state.channels = res;
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
         * TODO: ensure this does not happen to frequent
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
            this.state.members = res;
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
        this.state.bots = this.state.bots || [];
        SlackDebug("start bots", this.state.bots);

        function uniq(a, key) {
          var seen = {};
          return a.filter(function(item) {
            var k = key(item);
            return seen.hasOwnProperty(k) ? false : (seen[k] = true);
          });
        }

        this.state.bots = uniq(this.state.bots, item => {
          return item.id;
        });

        this.state.bots.forEach(bot => {
          var id = bot.id;
          SlackDebug("webrequest to find bot: " + id);
          var p = this.webClient
            .apiCall("bots.info", { bot: id })
            .then(res => {
              this.state.bots.find((element, index) => {
                if (element.id == res.bot.id) {
                  this.state.bots[index] = res.bot;
                }
              }, this);
            })
            .catch(e => {
              this.error(e);
            });

          promises.push(p);
        }, this);

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
         * TODO: ensure this does not happen to frequent
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
         * TODO: ensure this does not happen to frequent
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
       * lookup member based off of id
       */
      this.findMemberById = function(id) {
        SlackDebug("looking up member: " + id);
        var member = this.state.members.find(element => {
          if (element.id == id) {
            return true;
          }
        });

        return member;
      };

      /**
       * lookup member based off of name or @name syntax
       */
      this.findMemberByName = function(name) {
        SlackDebug("looking up member: " + name);
        var member = this.state.members.find(element => {
          if (
            element.deleted === false &&
            element.name == name.replace(/^@/, "")
          ) {
            return true;
          }
        });

        return member;
      };

      /**
       * lookup channel based off of id
       */
      this.findChannelById = function(id) {
        SlackDebug("looking up channel: " + id);
        var channel = this.state.channels.find(element => {
          if (element.id == id) {
            return true;
          }
        });

        return channel;
      };

      /**
       * channels start with:
       *  C - Conference (normal rooms)
       *  G - Group (multiuser, and private channels)
       *  D - Direct (user to user)
       */
      this.findChannelByName = function(name, type = null) {
        /**
         * this purposely does a lookup on both regardless to handle
         * use-cases where the # or @ is ommitted completely
         */
        var directChannel = null;
        var roomChannel = null;

        // do lockup by member name
        var member = this.findMemberByName(name);
        if (member) {
          directChannel = this.state.channels.find(element => {
            if (
              element.id[0] == "D" &&
              element.is_user_deleted === false &&
              element.user == member.id
            ) {
              return true;
            }
          });
        }

        // do lookup by channel name
        var roomChannel = this.state.channels.find(element => {
          if (
            element.is_archived === false &&
            element.name == name.replace(/^#/, "")
          ) {
            return true;
          }
        });

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
        this.state.bots = this.state.bots || [];
        var bot = this.state.bots.find(element => {
          if (element.id == id) {
            return true;
          }
        });

        if (!bot) {
          SlackDebug("webrequest to find bot: " + id);
          this.webClient
            .apiCall("bots.info", { bot: id })
            .then(res => {
              var found = false;
              this.state.bots.find((element, index) => {
                if (element.id == res.bot.id) {
                  this.state.bots[index] = res.bot;
                  found = true;
                }
              }, this);

              if (!found) {
                this.state.bots.push(res.bot);
              }

              function uniq(a, key) {
                var seen = {};
                return a.filter(function(item) {
                  var k = key(item);
                  return seen.hasOwnProperty(k) ? false : (seen[k] = true);
                });
              }

              this.state.bots = uniq(this.state.bots, item => {
                return item.id;
              });
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
        logLevel: process.env.SLACK_DEBUG ? "debug" : "info"
      });

      this.rtmClient.on("disconnected", e => {
        SlackDebug("disconnected " + this.shortToken(), e);
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
        this.refreshState();
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

      this.rtmClient.on("reconnecting", () => {
        SlackDebug("reconnecting " + this.shortToken());
        clearInterval(this.refreshIntervalId);
      });

      this.rtmClient.on("error", e => {
        SlackDebug("error " + this.shortToken(), e);
      });

      this.rtmClient.on("unable_to_rtm_start", e => {
        SlackDebug("unable_to_rtm_start " + this.shortToken(), e);
      });

      /**
       * This is meant to keep state mostly up to date however to not go
       * bonkers with performance it is not currently meant to be fully
       * comprehensive
       *
       * TODO: re-enable when timing logic has been added.  For now only
       * support the interval process.
       */
      this.rtmClient.on("slack_event", (eventType, event) => {
        switch (eventType) {
          case "user_change":
          case "team_join":
            //this.refreshMembers();
            break;
          case "channel_archive":
          case "channel_created":
          case "channel_deleted":
          case "channel_rename":
          case "channel_unarchive":
          case "member_joined_channel":
          case "member_left_channel":
            //this.refreshChannels();
            break;
          case "team_rename":
            //this.refreshTeam();
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
            console.log(this.rtmClient);
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
      this.connectionWatchdog();

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
    this.clientNode = RED.nodes.getNode(this.client);

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
        if (
          eventType == "pong" ||
          eventType == "hello" ||
          eventType == "ws_response"
        ) {
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
          case "message":
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
