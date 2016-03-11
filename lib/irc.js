"use strict";
var util    = require('util');
var net     = require('net');
var fs      = require('fs');
var events  = require('events');

var irc = function(server, nick, config) {
	server = server.split(':');
	config = Object.assign({
		server: {host: server[0], port: server[1]||6667},
		nick: nick,
		realName: config.realName || 'Node Bot',
		userName: config.userName || nick,
		commandPrefix: '!',
		commandPipe: '>'
	}, config)

	// This is the object we return
	var client = {};

	// Make the client an emitter
	var emitter = new events.EventEmitter();
	client.on = emitter.on.bind(emitter);
	client.off = emitter.removeListener.bind(emitter);
	client.emit = emitter.emit.bind(emitter);

	// This object keep tracks of our current connection status
	var connection = {
		connected: false,
		nick: nick,
		server: ''
	};

	// Create botmsg and chanmsg events from privmsg events
	// - botmsg when someone privmsg to the bot
	// - chanmsg when someone privmsg to a channel
	client.on('privmsg', (from, target, message) => {
		if (target == connection.nick) {
			client.emit('botmsg', from, message);
		} else if (target[0] == '#') {
			client.emit('chanmsg', from, target, message);
		}
	});

	// Socket stuff
	var buffer = '';
	var conn = null;
	client.connect = function(server, port) {
		var host = server || config.server.host;
		if (host === undefined || host.match(/^\s*$/)) {
			return client.emit('error', 'No server set.');
		}
		port = port || config.server.port;
		log('Connecting to ' + host + ':' + port);
		conn = net.connect({host, port}, connected);
		conn.on('error', error);
		conn.on('data', data);
		conn.on('end', () => log.debug('Connection ended'));
		conn.on('close', (err) => {
			if (err)
				log.error('Close: ' + err);
			disconnected(err);
		});
	};
	var disconnected = function(err) {
		err = err||false;
		log.debug('Disconnected, err=' + err);
		connection.connected = false;
		connection.nick = '';
		connection.server = '';
		client.emit('disconnected', err);
	};
	var connected = function() {
		log('Connection established.');
		connection.connected = true;
		send('NICK ' + config.nick);
		log.debug("NICK sent: " + config.nick);
		send('USER ' + config.userName + ' 8 * :' + config.realName);
		log.debug("USER sent: " + config.userName + ' 8 * :' + config.realName)
	};
	// We're not really connected until raw 001 is recieved
	client.on('001', (servername) => {
		log.debug('Connected to ' + servername);
		client.emit('connected', {server: servername});
	});

	// Regexp to find bot commands, eg. !seen <nick>
	// It's possible to pipe result of a command to someone else. Default pipe char is '>'
	// <Gates> !seen SomeOne > Bill
	// <Bot> Bill: I don't know SomeOne
	// This is no magic, the command developer needs to handle this. Last param for chancmd 
	// is the target nick (the one who triggered the command if no pipe)
	var commandRegex = new RegExp('^'+config.commandPrefix+'(\\w+) (.*?)(?:'+config.commandPipe+'\\s*(\\w+)\\s*)?$');
	client.on('chanmsg', (userinfo, channel, message) => {
		var matches = commandRegex.exec(message);
		if (matches == null) {
			return;
		}
		var command = matches[1].toLowerCase();
		var commandArguments = matches[2];
		var resultTarget = matches[3] || parseUserinfo(userinfo).nick;
		client.emit('chancmd', userinfo, channel, command, commandArguments, resultTarget);
		client.emit('chancmd:' + command, userinfo, channel, commandArguments, resultTarget);
	});

	// Socket data handler
	var data = function(data) {
		buffer += data.toString();
		while (buffer.indexOf('\n') >= 0) {
			data = buffer.substring(0,buffer.indexOf('\n')-1);
			buffer = buffer.substring(data.length+2);
			log.debug('READ: ' + data);
			var parts = data.split(' ');

			// Handle PING here. No need for plugin or events. 
			if (parts[0] == 'PING') {
				client.send('PONG ' + parts[1]);
				log.debug("PING? PONG!");
				continue;
			}
			// A line always begins with the "source" (user or server), followed by the command.
			// If its a server command it starts with colon, like ":server.name.tld", thats why we remove it.
			// The second token is the command. We'll use it as the event and send the source as first argument
			// in the event. Then just append all other tokens as arguemnts.
			// Example:
			//  | :irc.foonet.com 001 spuunbot :Welcome to the ROXnet IRC Network spuunbot!spuunbot@10.0.1.13
			//  | will trigger event "001" with arguments ["irc.foonet.com", "spuunbot", 
			//  | "Welcome to the ROXnet IRC Network botnick!botuser@bothost.com"]
			if (parts[0][0] == ':') {
				parts[0] = parts[0].substring(1);
			}
			var args = [parts[1].toLowerCase(), parts[0]];
			for (var i=2;i<parts.length;++i) {
				if (parts[i][0] == ':') {
					args.push(parts.slice(i).join(' ').substring(1));
					break;
				}
				args.push(parts[i]);
			}
			// Trigger som events. The specific server event (like privmsg, nick, raw numeric) but
			// two types of raw events. "raw" has the unparsed line as argument while raw:parsed
			// has the arguments parsed
			client.emit.apply(emitter, args);
			client.emit('raw', data);
			client.emit('raw:parsed', args); 
		}
	};
	var error = function(err) {
		for (var i=0;i<arguments.length;++i)
			log.error(arguments[i]);
	};
	var send = function(data) {
		if (!connection.connected) {
			log.warn('Couldn\'t send data. Not connected.');
			return;
		}
		log.debug('SEND: ' + data);
		conn.write(data + '\n');
	};

	var log = function (str) {
		util.log(str);
	};
	log.warn = function (str) {
		util.log('WARN: ' + str);
	};
	log.debug = function (str) {
		util.log('DEBUG: ' + str);
	};
	log.error = function (str) {
		util.log('ERROR: ' + str);
	}

	client.send = send;
	client.connection = connection;
	client.config = config;
	return client;
};
var parseUserinfo =  function(uinfo) {
	var nick = uinfo.substring(0,uinfo.indexOf('!'));
	var username = uinfo.substring(nick.length+1, uinfo.indexOf('@'));
	var host = uinfo.substring(uinfo.indexOf('@')+1);
	return {nick,username,host};
}
irc.tools = {
	parseUserinfo
}
module.exports = irc;