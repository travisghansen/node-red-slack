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

    var request = require('request');
    var slackBotGlobal = {};
    var connecting = false;

    // set this to true to spam your console with stuff.
    var slackDebug = true;

    function slackLogin(token, node){
        if(slackBotGlobal[token] && slackBotGlobal[token].connected === false && connecting === false) {
            if (slackDebug) { node.log("Slack not connected"); }
            connecting = true;
            slackBotGlobal[token].login();
        } else {
           if (slackDebug) { node.log("Slack already connected"); }
        }
    }

    function slackLogOut(token, node){
        if(slackBotGlobal[token]) {
            if (slackDebug) { node.log("Slack disconnecting."); }
            connecting = false;
            var dis = slackBotGlobal[token].disconnect();
            slackBotGlobal[token].removeAllListeners();
            slackBotGlobal = {};
        }
    }

    function slackReconnect(token, node) {
        slackLogOut(token, node);
        slackLogin(token, node);
    }

    function slackBotIn(n) {
        RED.nodes.createNode(this,n);

        this.channel = n.channel || "";
        this.apiToken = n.apiToken;
        var node = this;

        var Slack = require('slack-client');

        var token = this.apiToken;
        var autoReconnect = true;
        var autoMark = true;

        var slack = {};
        if(slackBotGlobal && slackBotGlobal[token]) {
            if (slackDebug) { node.log("IN: old slack session"); }
            slack = slackBotGlobal[token];
        } else {
            if (slackDebug) { node.log("IN: new slack session"); }
            slack = new Slack(token, autoReconnect, autoMark);

            slack.on('loggedIn', function () {
                node.log('in: Logged in: ');
            })

            slackBotGlobal[token] = slack;
        }

        slack.on('message', function(message) {
            var msg = {
                payload: message.text
            };

            var slackChannel = slack.getChannelGroupOrDMByID(message.channel);
            var fromUser = slack.getUserByID(message.user);

            if(!fromUser) {
                fromUser = {
                    name: ""
                };
            }

            if(node.channel === "" || slackChannel.name === node.channel) {
                passMsg();
            }

            function passMsg() {
                msg.slackObj = {
                    "id": message.id,
                    "type": message.type,
                    "text": message.text,
                    "channelName": slackChannel.name,
                    "channel": message.channel,
                    "fromUser": fromUser.name
                };

                node.send(msg);
            }

        });

        slack.on('error', function (error) {
            console.trace();
            node.error('Error: ' + error);

            if(error === 'ENOTFOUND') {
                slackLogin(token, node);
            }
        });

        slackLogin(token, node);
        setTimeout(function() {
            slackLogin(token, node);
        }, 10000);

        this.on('close', function() {
            slackLogOut(token, node);
        });

    };
    RED.nodes.registerType("Slack Bot In", slackBotIn);


    function slackBotOut(n) {
        RED.nodes.createNode(this,n);

        this.apiToken = n.apiToken;
        this.channel = n.channel || "";
        var node = this;

        var Slack = require('slack-client');

        var token = this.apiToken;
        var autoReconnect = true;
        var autoMark = true;

        var slack = {};
        if(slackBotGlobal && slackBotGlobal[token]) {
            if (slackDebug) { node.log("OUT: using an old slack session"); }
            slack = slackBotGlobal[token];
        } else {
            if (slackDebug) { node.log("OUT: new slack session"); }
            slack = new Slack(token, autoReconnect, autoMark);

            slack.on('loggedIn', function () {
                node.log('OUT: Logged in.');
            })

            slackBotGlobal[token] = slack;
        }

        this.on('input', function (msg) {
            if (slackDebug) { node.log(JSON.stringify(msg)); }

            if(!slack.connected) {
                node.log('Reconencting to Slack.');
                slackReconnect(token, node);
            }

            var channel = node.channel || msg.channel || "";

            var slackChannel = "";
            var slackObj = msg.slackObj;

            if(channel !== "") {
                if (slackDebug) { node.log("Getting slackChannel (" + channel + ") from node/message."); }
                slackChannel = slack.getChannelGroupOrDMByName(channel);
            } else {
                if (slackDebug) { node.log("Getting slackChannel (" + channel + ") from slackObj in message."); }
                slackChannel = slack.getChannelGroupOrDMByID(slackObj.channel);
            }

            if (slackDebug) node.log(typeof slackChannel);
            if(typeof slackChannel === "undefined") {
                node.error("'slackChannel' is not defined, check you are specifying a channel in the message (msg.channel) or the node config.");
                node.error("Message: '" + JSON.stringify(msg));
                slackLogin(token, node);
                return false;
            }

            if((slackChannel.is_member && slackChannel.is_member === false) || slackChannel.is_im === false) {
                node.warn("Slack bot is not a member of this Channel");
                return false;
            }

            try {
                slackChannel.send(msg.payload);
            }
            catch (err) {
                console.trace();
                node.log(err,msg);

                // Leave it 10 seconds, then log in again.
                setTimeout(function() {
                    slackLogin(token, node);
                }, 10000);
            }
        });

        slack.on('error', function (error) {
            console.trace();
            node.error('Error sending to Slack: ' + JSON.stringify(error));
        });

        slackLogin(token, node);
        setTimeout(function() {
            slackLogin(token, node);
        }, 10000);

        this.on('close', function() {
            slackLogOut(token, node);
        });
    }
    RED.nodes.registerType("Slack Bot Out", slackBotOut);


    function slackOut(n) {
        RED.nodes.createNode(this,n);

        this.channelURL = n.channelURL;
        this.username = n.username || "";
        this.emojiIcon = n.emojiIcon || "";
        var node = this;

        this.on('input', function (msg) {
            var channelURL = node.channelURL || msg.channelURL;
            var username = node.username || msg.username;
            var emojiIcon = node.emojiIcon || msg.emojiIcon;
            var channel = node.channel || msg.channel;

            var data = {
                "text": msg.payload,
                "username": username,
                "icon_emoji": emojiIcon
            };
            if (channel) { data.channel = channel; }
            if (msg.attachments) { data.attachments = msg.attachments; }
            if (slackDebug) { node.log(JSON.stringify(data)); }
            try {
                request({
                    method: 'POST',
                    uri: channelURL,
                    body: JSON.stringify(data)
                });
            }
            catch (err) {
                console.trace();
                node.log(err,msg);
            }
        });
    }
    RED.nodes.registerType("slack", slackOut);
};
