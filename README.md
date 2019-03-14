# node-red-contrib-slack

A <a href="http://nodered.org" target="_new">Node-RED</a> node to interact with
the <a href="https://slack.com/" target="_new">Slack</a>
<a href="https://api.slack.com/" target="_new">API</a>.

# Install

Run the following command in the root directory of your Node-RED install:

```
npm install --save node-red-contrib-slack
```

Version `2.x` of this package is **NOT** compatible with older versions. Plese
refer to the [migration](#migration-from-012-or-ealier) section for help.

# Usage

The nodes included in this package are **purposely** generic in nature. The
usage very closely mimics the
<a href="https://api.slack.com/" target="_new">Slack API</a>. Your best source
of reference for input/output specifics will be from:

- https://api.slack.com
- https://api.slack.com/rtm
- https://api.slack.com/web
- https://api.slack.com/methods

4 nodes are provided:

- [`slack-rtm-in`](#slack-rtm-in)
- [`slack-rtm-out`](#slack-rtm-out)
- [`slack-web-out`](#slack-web-out)
- [`slack-state`](#slack-state)

The `rtm` API/node(s) are connected to slack via web sockets and are useful for
receiving a real-time stream of events/data.

The `web` API/node(s) are useful for making traditional web service calls and
have a much broader use-case.

Combining both `rtm` and `web` APIs provides a full solution to interact with
the <a href="https://api.slack.com/" target="_new">Slack API</a> in it's
entirety facilitating powerful flows in `Node-RED`. Which nodes are
appropriate to use for any given use-case can be subjective so familiarizing
youself with the documentation links above is **extremely** beneficial.

## invoking methods

To invoke methods ([`slack-rtm-out`](#slack-rtm-out),
[`slack-web-out`](#slack-web-out)) set the `msg.topic` to the name of the
method and set the `msg.payload` to the args/params.

The `token` property is **NOT** required to be set in any `msg.payload`.

As an example of invoking the
<a href="https://api.slack.com/methods/chat.meMessage">`chat.meMessage`</a>
method with the [`slack-web-out`](#slack-web-out) node you would do the
following:

```
msg.topic = "chat.meMessage";
msg.payload = {
    channel: "...",
    text: "..."
}

return msg;
```

## `dressed` responses

All responses/events are traversed before output to automatically do lookups on
your behalf to add additional info directly into the `msg.payload` (examples
provided below). All of the lookups are done dynamically/generically so
regardless of what API response you get if the node finds an attribute that
appears to be a supported object (`user`/`channel`/`team`/`bot`) in some shape
or form, a corresponding `<attribute>Object` attribute with the lookup value
will be added.

For example, if the response contains a `bot_id` attribute you would see
`bot_idObject` added, or if it found an attribute called `bot` it would add
`botObject` etc. Ultimately all the lookups com from
[`slackState`](#slackstate) (see below) so it could be done on your own but
it's added to simplify and for convenience.

An example
<a href="https://api.slack.com/events/user_typing" target="_new">`user_typing`</a>
event from the [`slack-rtm-in`](#slack-rtm-in) node:

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

## Helpers

As a convenience for both the [`slack-web-out`](#slack-web-out) and
[`slack-rtm-out`](#slack-rtm-out) nodes a special interface is supported that
allows you to send a message with a simplified structure (`msg.topic` starts
with `@` or `#`):

```
msg.topic = "@some_user";
# or
msg.topic = "#some_channel";

msg.payload = "a special message just for you"

return msg
```

As an additional convenience, if you are invoking the
<a href="https://api.slack.com/methods/chat.meMessage" target="_new">`chat.meMessage`</a>,
<a href="https://api.slack.com/methods/chat.postEphemeral" target="_new">`chat.postEphemeral`</a>,
<a href="https://api.slack.com/methods/chat.postMessage" target="_new">`chat.postMessage`</a>
methods ([`slack-web-out`](#slack-web-out)), or
<a href="https://api.slack.com/rtm">`message`</a> method
([`slack-rtm-out`](#slack-rtm-out)) and the `channel` starts with `@` or `#`
the node will automatically lookup the appropriate `channel.id` from
[`slackState`](#slackstate) (see below) and set it for you.

## `slackState`

All outputs for all nodes include a `msg.slackState` object which has several
properties containing the lists of `members`/`channels`/`bots`/`team`/etc so
downstream nodes can do 'lookups' without re-hitting the API (this data is
currently refreshed in the background every 10 minutes). Additionally the
internal state is connected to all relevant slack events and updates are
reflected real-time in any new messages (ie: a user getting created
automatically updates the `slackState` even before the 10 minute refresh).

## nodes

### `slack-rtm-in`

The [`slack-rtm-in`](#slack-rtm-in) node listens to all
<a href="https://api.slack.com/rtm" target="_new">Slack RTM</a> events and
outputs the [`dressed`](#dressed-responses) response as the `msg.payload`.

### `slack-rtm-out`

Invokes a <a href="https://api.slack.com/rtm" target="_new">Slack RTM</a>
method and outputs the [`dressed`](#dressed-responses) response as the
`msg.payload`.

Available methods:

- `message`: send a message
- `ping`: pong
- <a href="https://api.slack.com/events/presence_sub" target="_new">`presence_sub`</a>:
  to subscribe to
  <a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
  events
- <a href="https://api.slack.com/events/presence_query" target="_new">`presence_query`</a>:
  to request a one-time
  <a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
  status
- `typing`: to send typing indicators

Using [`slack-rtm-out`](#slack-rtm-out) for sending messages should only be
used for very basic messages, preference would be to use the
<a href="https://api.slack.com/methods/chat.postMessage" target="_new">`chat.postMessage`</a>,
method of the [`slack-web-out`](#slack-web-out) node for anything beyond the
simplest messaging use-case as it supports
<a href="https://api.slack.com/docs/attachments" target="_new">`attachments`</a>
as well as many other features.

<a href="https://api.slack.com/events/presence_sub" target="_new">`presence_sub`</a>
is a powerful [`slack-rtm-out`](#slack-rtm-out) method that allows you to
receive
<a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
events on the [`slack-rtm-in`](#slack-rtm-in) node. See the
[presence](#presence) example below for further details.

### `slack-web-out`

Invokes a <a href="https://api.slack.com/methods" target="_new">Slack Web</a>
method and outputs the [`dressed`](#dressed-responses) response as the
`msg.payload`.

### `slack-state`

[`slack-state`](#slack-state) outputs a message with
[`msg.slackState`](#slackstate) added. If the `msg.payload` sent to
[`slack-state`](#slack-state) is `true` then it will first do a full refresh of
the state (should not generally be necessary) and then output the `msg`.

The `state events` (2nd) output of the node emits a signal when the state has
been fully initialized after (re)connect. This can be useful if you want to
perform any post initilization tasks (ie:
<a href="https://api.slack.com/events/presence_sub" target="_new">`presence_sub`</a>
).

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
[`slack-rtm-in`](#slack-rtm-in) node and a [`slack-web-out`](#slack-web-out)
node:

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
if (msg.payload.bot_id || (msg.payload.userObject && msg.payload.userObject.is_bot)) {
    return null;
}

// if you only want to watch a specific channel put name here
var channel = "";
if (channel && !msg.payload.channelObject) {
    return null;
}

if (channel && msg.payload.channelObject.name != channel.replace(/^@/, "").replace(/^#/, "")) {
    return null;
}

// only specific users
var username = "";
if (username && !msq.payload.userObject) {
    return null;
}

if (username && msq.payload.userObject.name.replace(/^@/, "") != username)) {
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

While [`slackState`](#slackstate) does not automatically subscribe to
<a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
events for you, it will keep track of `presence` details in
[`slackState`](#slackstate) if any
<a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
events are received (this is all done behind the scenes).

To subscribe to
<a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
events for all your users place the following `function` node between the
`slack events` output of the [`slack-state`](#slack-state) node and the
[`slack-rtm-out`](#slack-rtm-out) node:

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

1.  wait for the [`slackState`](#slackstate) to be initialized so you have a
    complete list of `members`
1.  iterate that list to build up the appropriate request to
    [`slack-rtm-out`](#slack-rtm-out)
1.  subscribe to presence events by sending the message to
    [`slack-rtm-out`](#slack-rtm-out)
1.  receive presence events on the [`slack-rtm-in`](#slack-rtm-in) node

Immediately after the request is sent you will see a flood of
<a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
events emitted on the [`slack-rtm-in`](#slack-rtm-in) node. Once the initial
flood of messages has passed continued updates will come through as
appropriate. Again, behind the scenes the [`slack-state`](#slack-state) nodes
are listening for these events and updating the
[`slackState.presence`](#slackstate) values appropriately for general
usage/consumption in your flow(s).

If you are really interested in keeping the data updated you could capture
`team_join` events from a [`slack-rtm-in`](#slack-rtm-in) node and wire those
to the above `function` node as well triggering the same procedure when new
users join the `team`. You may need to put a `delay` node before the
`function` node just to give [`slackState`](#slackstate) enough time to process
this same event and update.

An alternative would be to wire an `inject` node to the `function` node and put
it on a sane `interval` such as every 10 minutes.

If you wanted to be **really** sure you are receiving all
<a href="https://api.slack.com/events/presence_change" target="_new">`presence_change`</a>
events for the whole `team` do all the above.

# migration from `0.1.2` or ealier

In order to replicate the previous behavior it is possible to introduce simple
`function` nodes.

Roughly speaking the node equivalents are:

| `0.1.2`                           | `2.x`                             |
| --------------------------------- | --------------------------------- |
| [`slack`](#slack)                 | [`slack-web-out`](#slack-web-out) |
| [`Slack Bot In`](#slack-bot-in)   | [`slack-rtm-in`](#slack-rtm-in)   |
| [`Slack Bot Out`](#slack-bot-out) | [`slack-rtm-out`](#slack-rtm-out) |

## `slack`

To replicate the `slack` node simply place the following `function` node just
before the new [`slack-web-out`](#slack-web-out) node:

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
downstream from the new [`slack-rtm-in`](#slack-rtm-in) node:

```
// https://api.slack.com/events/message

if (msg.payload.type != "message") {
    return null;
}

// if you only want to watch a specific channel put name here
var channel = "";
if (channel && !msg.payload.channelObject) {
    return null;
}

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
node just before the new [`slack-rtm-out`](#slack-rtm-out) node:

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
- https://slack.dev/node-slack-sdk/
- https://slack.dev/node-slack-sdk/rtm_api
- https://slack.dev/node-slack-sdk/web_api
