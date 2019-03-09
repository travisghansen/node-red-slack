# node-red-contrib-slack

A <a href="http://nodered.org" target="_new">Node-RED</a> node to interact with
the <a href="https://slack.com/" target="_new">Slack</a>
<a href="https://api.slack.com/" target="_new">API</a>.

# Install

Run the following command in the root directory of your Node-RED install:

```
npm install --save node-red-contrib-slack
```

# Usage

The nodes included in this package are **purposely** generic in nature. The
usage very closely mimics the **Slack**
<a href="https://api.slack.com/" target="_new">API</a>. Your best source of
reference for input/output specifics will be from:

 * https://api.slack.com/web
 * https://api.slack.com/methods
 * https://api.slack.com/rtm

The `rtm` API/node(s) are connected to slack via web sockets and are useful for
receiving a real-time stream of events/data.

The `web` API/node(s) are useful for making traditional web service calls and
have a much broader use-case.

Combining both `rtm` and `web` APIs provides a full solution to interact with
the slack API in it's entirety facilitating powerful flows in `Node-RED`.
Which nodes are appropriate to use for any given use-case can be subjective so
familiarizing youself with the documentation links above is **extremely**
beneficial.

To invoke methods (`slack-rtm-out`, `slack-web-out`) set the `msg.topic` to the
name of the function/method and set the `msg.payload` to the args/params.

The `token` property is **NOT** required to be set in any `msg.payload`.

As an example of invoking the
<a href="https://api.slack.com/methods/chat.meMessage">`chat.meMessage`</a>
with the `slack-web-out` node you would do the following:

```
msg.topic = "chat.meMessage";
msg.payload = {
    channel: "...",
    text: "..."
}

return msg;
```

As a convenience for both the `slack-web-out` and `slack-rtm-out` nodes a
special interface is supported that allows you to send a message with a
simplified structure (topic starts with `@` or `#`):

```
msg.topic = "@some_user";
# or
msg.topic = "#some_channel";
msg.payload = "a special message just for you"

return msg
```

As an additional convenience, if you are invoking the `chat.meMessage`,
`chat.postEphemeral`, `chat.postMessage` (`slack-web-out`) or `message` method
(`slack-rtm-out`) and the `channel` starts with `@` or `#` the node will
automatically lookup the appropriate `channel.id` from `slackState` (see below)
and set it for you.

All outputs for all nodes include a `msg.slackState` object which has several
properties containing the lists of `members`/`channels`/`bots`/`team`/etc so
downstream nodes can do 'lookups' without re-hitting the API (this data is
currently refreshed in the background every 10 minutes). Additionally the
internal state is connected to all relevant slack events and updates are
reflected real-time in any new messages (ie: a user getting created
automatically updates the `slackState` even before the 10 minute refresh).

## `dressed` responses

All responses/events are traversed before output to automatically do lookups on
your behalf to add addiational info directly into the `msg.payload` (examples
provided below). All of the lookups are done dynamically/generically so
regardless of what API response you get if the node finds an attribute that
appears to be a `user` in some shape or form, it creates `<attribute>Object`
attribute with the user lookup value.

For example, if the response contains a `bot_id` attribute you would see
`bot_idObject` added, but if it found an attribute called `bot` it would add
`botObject` etc. Ultimately it's doing all the lookups from `slackState` so it
could be done on your own but it's added to simplify and for convenience.

An example
<a href="https://api.slack.com/events/user_typing" target="_new">`user_typing`</a>
event from the `slack-rtm-in` node:

```
{
  "type": "user_typing",
  "channel": "...",
  "user": "..."
}
```

is `dressed` to be sent as:

```
{
  "type": "user_typing",
  "channel": "...",
  "user": "...",
  "channelObject": {
    "id": "...",
    "name": "...",
    "is_channel": true,
    "is_group": false,
    "is_im": false,
    "created": 1434735155,
    ...
  },
  "userObject": {
    "id": "...",
    "name": "...",
    "real_name": "...",
    ...
  }
}
```

## `slack-rtm-in`

The `slack-rtm-in` node listens to all **Slack** events as described in the
<a href="https://api.slack.com/rtm" target="_new">docs</a> and outputs the
`dressed` response as the `msg.payload`.

## `slack-rtm-out`

Very few <a href="https://api.slack.com/rtm" target="_new">methods</a> exist
that can be invoked by this node:

- `message`: send a message
- `ping`: pong
- `presence_sub`: to subscribe to presence change events
- `presence_query`: to request a one-time presence status
- `typing`: to send typing indicators

Using `slack-rtm-out` for sending messages should only be used for very basic
messages, preference would be to use the `slack-web-out` `chat.postMessage`
method for anything beyond the simplest messaging use-case as it supports
`attachments` as well as many other features.

<a href="https://api.slack.com/events/presence_sub" target="_new">`presence_sub`</a>
is a powerful `slack-rtm-out` method that allows you to receive
`presence` events on the `slack-rtm-in` node. See the presence example below
for further details.

## `slack-web-out`

You can invoke any of the available
<a href="https://api.slack.com/methods" target="_new">`methods`</a>. The
output is the `dressed` response.

## `slack-state`

`slack-state` outputs a message with `msg.slackState` added. If the
`msg.payload` sent to `slack-state` is `true` then it will first do a full
refresh of the state (should not generally be necessary) and then output the
`msg`.

The `state events` (2nd) output of the node emits a signal when the state has
been fully initialized after (re)connect. This can be useful if you want to
perform any post intilization tasks (ie `presence_sub`).

An example `ready` event:

```
{
    "type": "ready",
    "slackState": {
        ...
    }
}
```

# Examples / Advanced

## respond to keyword

A simple respond to `keyword` example `function` node to place between a
`slack-rtm-in` node and a `slack-web-out` node:

```
// ignore anything but messages
if (msg.payload.type != "message") {
    return null;
}

// ignore deleted messages
if (msg.payload.subtype == "message_deleted") {
    return null;
}

// ignore messages from bots
if (msg.payload.bot_id || msg.payload.userObject.is_bot) {
    return null;
}

// if you only want to watch a specific channel put name here
var channel = "";
if (channel && msg.payload.channelObject.name != channel.replace(/^@/, "").replace(/^#/, "")) {
    return null;
}

// only specific users
var username = "";
if (username && msq.payload.userObject.name.replace(/^@/, "") != username) {
    return null;
}

// check for keyword
// could use regex etc
if (!msg.payload.text.includes("keyword")) {
    return null;
}

// prepare outbound response
var topic = "chat.postMessage";
var payload = {
    channel: msg.payload.channel, // respond to same channel
    //text: '<@' + msg.payload.userObject.name + '>, thanks for chatting',
    text: '<@' + msg.payload.user + '>, thanks for chatting',
    //as_user: false,
    //username: "",
    //attachments: [],
    //icon_emoji: "",
}

msg = {
    topic: topic,
    payload: payload
}

return msg;
```

## presence

While the nodes do not automatically subscribe to `presence` events for you,
it will keep track of `presence` details in `slackState` if any
`presence_change` events are received (this is all done behind the scenes).

To subscribe to `presence` events for all your users place the following
`function` node between the `slack events` output of the `slack-state` node
and the `slack-rtm-out` node:

```
msg.topic = 'presence_sub';
var ids = [];

for (var id in msg.slackState.members) {
  if (msg.slackState.members.hasOwnProperty(id)) {
    ids.push(id)
  }
}

msg.payload = {
    ids: ids
}
return msg;
```

The theory of operation is:
 1. wait for the `slackState` to be initialized so you have a complete list of
 `members`
 1. iterate that list to build up the appropriate request to `slack-rtm-out`
 1. subscribe to presence events
 1. receive presence events on the `slack-rtm-in` node

Immediately after the request is sent you will see a flood of `presence_change`
events emitted on the `slack-rtm-in` node. Once the initial flood of messages
has passed continued updates will come through as appropriate. Again, behind
the scenes the `slack-state` nodes are listening for these events and updating
the `slackState.presence` values appropriately for general usage/consumption in
your flow(s).

# migration from `0.x.y`

In order to replicate the previous behavior it is possible to introduce simple
`function` nodes.

## `slack`

To replicate the `slack` node simply place the following `function` node just
before the new `slack-web-out` node:

```
// https://api.slack.com/methods/chat.postMessage
msg.topic = "chat.postMessage"
var payload = {
    text: msg.payload
};

// set default username (replicate the node configuration value)
var username = "";
if (username) {
    payload.username = username;
    payload.as_user = false;
} else if (msg.username) {
    payload.username = msg.username;
    payload.as_user = false;
}

// set default emojiIcon (replicate the node configuration value)
var emojiIcon = "";
if (emojiIcon) {
    payload.icon_emoji = emojiIcon;
} else if (msg.emojiIcon) {
    payload.icon_emoji = msg.emojiIcon;
}

// set default channel (replicate the node configuration value)
var channel = "";
if (channel) {
    payload.channel = channel;
} else if (msg.channel) {
    payload.channel = msg.channel
}

if (msg.attachments) {
    payload.attachments = msg.attachments;
}

msg.payload = payload;

return msg;
```

## `Slack Bot In`

To replicate the `Slack Bot In` node simply place the following `function` node
downstream from the new `slack-rtm-in`node:

```
// https://api.slack.com/events/message

if (msg.payload.type != "message") {
    return null;
}

// if you only want to watch a specific channel put name here
var channel = "";
if (channel && msg.payload.channelObject.name != channel.replace(/^@/, "").replace(/^#/, "")) {
    return null;
}

var payload = "";
if (msg.payload.text) {
    payload += msg.payload.text;
}

if (msg.payload.attachments) {
    if (payload) {
        payload += "\n";
    }

    msg.payload.attachments.forEach((attachment, index) => {
        if (index > 0) {
            payload += "\n";
        }
        payload += attachment.fallback;
    })
}

var slackObj = {
    id: msg.payload.client_msg_id,
    type: msg.payload.type,
    text: msg.payload.text,
    channelName: msg.payload.channelObject.name,
    channel: msg.payload.channelObject,
    fromUser: (msg.payload.userObject) ? msg.payload.userObject.name : "",
    attachments: msg.payload.attachments
};

msg = {
    payload: payload,
    slackObj: slackObj
}

return msg;
```

## `Slack Bot Out`

To replicate the `Slack Bot Out` node simply place the following `function`
node just before the new `slack-rtm-out` node:

```
// set channel
var channel = "";
if (channel) {
    // do nothing, use the provided channel
} else if (msg.channel) {
    channel = msg.channel;
} else if (msg.slackObj && msg.slackObj.channel) {
    channel = msg.slackObj.channel
} else {
    node.error("'slackChannel' is not defined, check you are specifying a channel in the message (msg.channel) or the node config.");
    node.error("Message: '" + JSON.stringify(msg));
    return null;
}

msg = {
    topic: channel,
    payload: msg.payload
}

return msg;
```

# Additional Resources

- <a href="http://emoji-cheat-sheet.com" target="_new">Emoji Cheat Sheet</a>
- <a href="https://api.slack.com/docs/attachments" target="_new">Slack Attachments</a>
