// CONST
GITHUB_ID = process.env.GITHUB_ID
GITHUB_TOKEN = process.env.GITHUB_TOKEN
GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN
SECRETS = [process.env.SECRET]
PORT = process.env.PORT || +process.argv[2] || 80

// core libs
fs    = require("fs")
url   = require("url")
http  = require("http")
https = require("https")

request = require("request")

// file server
node_static = require("node-static")
fileserver = new node_static.Server(".")

// cookies
Cookies = require("cookies")

Keygrip = require("keygrip")
keys    = new Keygrip(SECRETS)

// oauth
OAuth2 = require("oauth").OAuth2
github = new OAuth2(
  GITHUB_ID,
  GITHUB_TOKEN,
  "https://github.com/login/oauth/",
  "authorize",
  "access_token"
)

// index data
var index = {}

// routes
routes = [
  /^\/api/             , apiHandler    ,

  /^\/login$/          , loginHandler  ,
  /^\/logout$/         , logoutHandler ,
  /^\/oauth_redirect$/ , authHandler   ,

  /^\/favicon\.ico$/   , staticHandler ,
  /^\/static/          , staticHandler ,

  /.*/                 , defaultHandler
]

apiRoutes = [
  /^\/api\/me$/              , currentUser,
  /^\/api\/users\/([\w-]+)$/ , user,
  /^\/api\/keywords\/(\w+)$/ , keyword,
  /^\/api\/$/                , currentEntries
]

// handlers
function staticHandler(req, res) {
  req.addListener("end", function() {
    fileserver
      .serve(req, res)
      .addListener("error", function(err) {
        console.log("Error serving " + req.url, err.message)
      })
  })
}

function authHandler(req, res) {
  var next = req.url.query.next || url.format(url.resolve(req.url, "/"))
    , code = req.url.query.code

	github.getOAuthAccessToken(code, {}, function(err, access, refresh) {
		github.get(
			"https://api.github.com/user",
			access,
			function(err, data, response) {
			  if (err) return res.end()

			  var user = JSON.parse(data)

				req.cookies.set("id", user.login, {signed: true})
				res.writeHead(307, {Location: next})
				res.end()
			}
		)
	})
}

function loginHandler(req, res) {
	var next = github.getAuthorizeUrl()

	res.writeHead(307, {Location: next})
	res.end()
}

function logoutHandler(req, res) {
  var next = req.url.query.next || url.format(url.resolve(req.url, "/"))

  req.cookies.set("id", null, {signed: true})
  res.writeHead(307, {Location: next})
  res.end()
}

function apiHandler(req, res) {
  var callback = req.url.query.callback
    , handler
    , i = 0
    , route

  for (; route = apiRoutes[i++]; i++) {
    if (route.test(req.url.pathname)) {
      handler = apiRoutes[i]
      req.url.captures = req.url.pathname.match(route)
      break
    }
  }

  if (!callback || /\W/.test(callback)) callback = "alert"

	handler || (handler = function(cb){ cb(404, "Not found.") })

  handler(req, function(err, data) {
    if (err) {
      res.writeHead(404)
      return res.end('{error: "Not found."}')
    }

    var ret = callback + "(" + JSON.stringify(data) + ")"

    res.writeHead(200, {
      "Content-Type":   "text/javascript",
      "Content-Length": Buffer.byteLength(ret)
    })

    res.end(ret)
  })
}

function defaultHandler(req, res) {
  req.url = "/static/index.html"
  staticHandler(req, res)
}

function currentUser(req, cb) {
  var id = req.cookies.get("id", {signed: true})

  cb(null, id && {id: id})
}

function currentEntries(req, cb) {
  var ids = Object.keys(index.entries.byId)
    , randomEntries = []
    , i = 4

  while (i--) randomEntries[i] = index.entries.byId[
    ids.splice(0|Math.random()*ids.length, 1)[0]
  ]

  cb(null, {
    entries:  randomEntries,
    keywords: index.keywords.list,
    users:    index.users.list
  })
}

function user(req, cb) {
  var data = index.users.byName[req.url.captures[1]]
    , ret = {}

  for (var name in data) ret[name] = data[name]
  ret.entries = data.entries.map(function(id){ return index.entries.byId[id] })

  data ? cb(null, ret) : cb(404)
}

function keyword(req, cb) {
  var data = Object
    .keys(index.keywords.byWord[req.url.captures[1]])
    .map(function(id){ return index.entries.byId[id] })

  cb(null, data)
}

// setup
http.createServer(function listener(req, res) {
  req.url = url.parse(req.url, true)
  req.cookies = new Cookies(req, res, keys)

  for (var i = 0, route; route = routes[i++]; i++) {
    if (route.test(req.url.pathname)) return routes[i](req, res)
  }
}).listen(PORT)

console.log("140byt.es now running on port " + PORT)

gistEndpoint = url.format({
  protocol: "https:",
  hostname: "api.github.com",
  pathname: "/gists/starred",
  query: {
    access_token: GITHUB_ACCESS_TOKEN,
    per_page: 100
  }
})

function getEntries(entries, uri) {
  entries || (entries = [])
  uri || (uri = gistEndpoint)

  console.log("fetching entries at " + uri)

  request({uri: uri}, function(err, response, body) {
    if (err) console.log("entries could not be fetched: " + err.message)

    else {
      var link = response.headers.link

      uri = (link && link.match(/<([^>]+)>; rel="next"/) || 0)[1]
      entries = entries.concat(JSON.parse(body))

      if (uri) return getEntries(entries, uri)

      else {
        console.log(entries.length + " entries found. checking freshness...")
        updateEntries(entries)
      }
    }
  })
}




function updateEntries(entries) {
  var remote = entries[0], local, path

  if (!remote) return indexEntries()

  path = "./data/entries/" + remote.id + ".json"

  fs.readFile(path, "utf8", function(err, body) {
    local = body && JSON.parse(body)

    if (err || remote.updated_at != local.updated_at) {
      console.log("fetching entry " + remote.id + "...")
      remote.url += "?access_token=" + GITHUB_ACCESS_TOKEN
      request({uri: remote.url }, function(err, response, body) {
        if (err) console.log("entry could not be fetched: " + err.message)
        else fs.writeFile(path, body, "utf8", function(err) {
          if (err) {
            console.log("entry could not be written: " + err.message)
          } else {
            updated = true
            updateEntries(entries)
          }
        })
      })
    }

    else {
      console.log("entry " + remote.id + " is up to date.")
      updateEntries(entries.slice(1))
    }
  })
}

function indexEntries() {
  index = {
    entries: {
      byId: {}
    },

    keywords: {
      byWord: {},
      list: []
    },

    users: {
      byId: {},
      byName: {},
      list: []
    }
  }

  // from @atk's entry at https://gist.github.com/1102380
  var cleanJSON = function j(a,b,c){return c?(b?'"'+b+'"':''):JSON.stringify(JSON.parse(a.replace(/\s*\/\/.*?\n|\s*\/\*.*?\*\/|,(?=\s*[\]}])|'(.*?)'/g,j)))}

  console.log("indexing entries...")

  fs.readdir("./data/entries", function(err, entries) {
    !function loop(entries) {
      var entry = entries.shift()

      if (!entry) {
        for (var word in index.keywords.byWord) {
          index.keywords.list.push([word, Object.keys(index.keywords.byWord[word]) ])
        }

        for (var name in index.users.byId) {
          index.users.list.push(index.users.byId[name])
        }

        index.users.list.sort(function(a, b){ return b.entries.length - a .entries.length })
        index.keywords.list.sort(function(a, b){ return b[1].length - a[1].length })
      }

      else fs.readFile("./data/entries/" + entry, "utf8", function(err, data) {
        var meta, data

        try {
          data = JSON.parse(data)

          try {
            meta = JSON.parse(data.files["package.json"].content)
          }

          catch(e) {
            meta = cleanJSON(data.files["package.json"].content)
            meta = JSON.parse(meta)
          }

          meta.keywords = meta.keywords.map(function(word) {
            word = word.toLowerCase().replace(/\W/g,"")
            index.keywords.byWord[word] || (index.keywords.byWord[word] = {})
            index.keywords.byWord[word][data.id] = 1
            return word
          })

          user = index.users.byId[data.user.id] || (index.users.byId[data.user.id] = data.user)
          user.entries || (user.entries = [])
          index.users.byName[data.user.login] = user
          user.entries.push(data.id)
          index.entries.byId[data.id] = {
            id: data.id,
            name: meta.name,
            code: data.files["index.js"].content,
            description: meta.description || data.description,
            author: user.login,
            keywords: meta.keywords
          }
        }

        catch (e) {
          console.log("package.json malformed for " + entry)
        }

        loop(entries)
      })
    }(entries)
  })
}

// uncomment to fetch new ones
getEntries()

indexEntries()
setInterval(getEntries, 1000 * 60 * 60)

process.on("uncaughtException", function(e){ console.log(e.stack) })
