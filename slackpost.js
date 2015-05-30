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

    function slackLogin(token){
        if(slackBotGlobal[token] && slackBotGlobal[token].connected === false) {
            console.log("not connected");
            slackBotGlobal[token].login();
        } else {
            console.log("connected");  
        }       
    }

    function slackLogOut(token){
        if(slackBotGlobal[token] && slackBotGlobal[token].connected === true) {
            console.log("not connected");
            var dis = slackBotGlobal[token].disconnect();
            console.log("dis: ", dis);
            slackBotGlobal[token].removeAllListeners();
            slackBotGlobal = {};
        } else {
            console.log("connected");  
        }       
    }

    function slackBotIn(n) {
        RED.nodes.createNode(this,n);
        
        this.channel = n.channel || "";
        this.apiToken = n.apiToken;
        this.botName = n.botName || "";
        this.emojiIcon = n.emojiIcon || "";
        var node = this;
                         
        var Slack = require('slack-client');
        
        var token = this.apiToken;
        var autoReconnect = true;
        var autoMark = true;
     
        var slack = {};                  
        if(slackBotGlobal && slackBotGlobal[token]) {
            console.log("IN: old slack session");            
            slack = slackBotGlobal[token];            
        } else {
            console.log("IN: new slack session"); 
            slack = new Slack(token, autoReconnect, autoMark);
            slackBotGlobal[token] = slack;            
        }


        slack.on('message', function(message) {
            var msg = { 
                payload: message.text
            };
            
            var slackChannel = slack.getChannelGroupOrDMByID(message.channel);
            var fromUser = slack.getUserByID(message.user);
            
            console.log("node.channel: ", node.channel);
            console.log("slackChanName: ", slackChannel.name);
            
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
            this.error('Error: %s', error); 
        });
        
        slackLogin(token);
//        setTimeout(function() {
//            slackLogin(token);
//        }, 10000);    
     
        this.on('close', function() {
            slackLogOut(token);
        });  
        
    };
    RED.nodes.registerType("slackBotIn", slackBotIn);

    
    function slackBotOut(n) {
        RED.nodes.createNode(this,n);

        this.channelName = n.channelname;
        this.apiToken = n.apiToken;
        this.botName = n.botName || "";
        this.emojiIcon = n.emojiIcon || "";
        var node = this;
    
        var Slack = require('slack-client');
        
        var token = this.apiToken;
        var autoReconnect = true;
        var autoMark = true;
    
        var slack = {};                  
        if(slackBotGlobal && slackBotGlobal[token]) {
            console.log("OUT: using an old slack session");
            slack = slackBotGlobal[token];            
        } else {  
            console.log("OUT: new slack session");
            slack = new Slack(token, autoReconnect, autoMark);
            slackBotGlobal[token] = slack;            
        }      
           
        this.on('input', function (msg) { 
            console.log("sending a message");
            var channelName = node.channelName;
            var botName = node.botName || msg.botName;
            var emojiIcon = node.emojiIcon || msg.emojiIcon;
            var channel = node.channel || msg.channel;
            
            var slackObj = msg.slackObj;
           
            var slackChannel = slack.getChannelGroupOrDMByID(slackObj.channel);

            try {
                slackChannel.send(msg.payload);
            }
            catch (err) {
                node.log(err,msg);
            }
        });
     
        this.on('close', function() {
            slackLogOut(token);
        });          
    }
    RED.nodes.registerType("slackBotOut", slackBotOut);
    

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

            try {
                request({
                    method: 'POST',
                    uri: channelURL,
                    body: JSON.stringify(data)
                });
            }
            catch (err) {
                node.log(err,msg);
            }
        });
    }
    RED.nodes.registerType("slack", slackOut);
};
