const express = require('express');
const passport = require('passport');
const cookieSession = require('cookie-session');


// our database operations
const dbo = require('./databaseOps');

// Promises-wrapped version of sqlite3
const db = require('./sqlWrap');

// functions that verify activities before putting them in database
const act = require('./activity');


const GoogleStrategy = require('passport-google-oauth20');

// Google login credentials, used when the user contacts
// Google, to tell them where he is trying to login to, and show
// that this domain is registered for this service. 
// Google will respond with a key we can use to retrieve profile
// information, packed into a redirect response that redirects to
// server162.site:[port]/auth/redirect

const hiddenClientID = process.env['ClientID']
const hiddenClientSecret = process.env['ClientSecret']

// An object giving Passport the data Google wants for login.  This is 
// the server's "note" to Google.
const googleLoginData = {
    clientID: hiddenClientID,
    clientSecret: hiddenClientSecret,
    callbackURL: '/auth/accepted',
    proxy: true
};


// Tell passport we will be using login with Google, and
// give it our data for registering us with Google.
// The gotProfile callback is for the server's HTTPS request
// to Google for the user's profile information.
// It will get used much later in the pipeline. 
passport.use(new GoogleStrategy(googleLoginData, gotProfile) );


// Let's build a server pipeline!

// app is the object that implements the express server
const app = express();

// use this instead of the older body-parser
app.use(express.json());

// make all the files in 'public' available on the Web
app.use(express.static('public'))


// pipeline stage that just echos url, for debugging
app.use('/', printURL);

// Check validity of cookies at the beginning of pipeline
// Will get cookies out of request object, decrypt and check if 
// session is still going on. 
app.use(cookieSession({
    maxAge: 6 * 60 * 60 * 1000, // Six hours in milliseconds
    // after this user is logged out.
    // meaningless random string used by encryption
    keys: ['hanger waldo mercy dance']  
}));

// Initializes passport by adding data to the request object
app.use(passport.initialize()); 

// If there is a valid cookie, this stage will ultimately call deserializeUser(),
// which we can use to check for a profile in the database
app.use(passport.session()); 

// Public static files - /public should just contain the splash page
app.get("/", (request, response) => {
  response.sendFile(__dirname + "/public/splash.html");
});

app.get('/*',express.static('public'));

// next, handler for url that starts login with Google.
// The app (in public/login.html) redirects to here 
// (it's a new page, not an AJAX request!)
// Kicks off login process by telling Browser to redirect to
// Google. The object { scope: ['profile'] } says to ask Google
// for their user profile information.
app.get('/auth/google',
	passport.authenticate('google',{ scope: ['profile'] }) );
// passport.authenticate sends off the 302 (redirect) response
// with fancy redirect URL containing request for profile, and
// client ID string to identify this app. 
// The redirect response goes to the browser, as usual, but the browser sends it to Google.  
// Google puts up the login page! 

// Google redirects here after user successfully logs in
// This route has three middleware functions. It runs them one after another.
app.get('/auth/accepted',
	// for educational purposes
	function (req, res, next) {
	    console.log("at auth/accepted");
	    next();
	},
	// This will issue Server's own HTTPS request to Google
	// to access the user's profile information with the 
	// temporary key we got in the request. 
	passport.authenticate('google'),
	// then it will run the "gotProfile" callback function,
	// set up the cookie, call serialize, whose "done" 
	// will come back here to send back the response
	// ...with a cookie in it for the Browser! 
	function (req, res) {
	    console.log('Logged in and using cookies!')
      // tell browser to get the hidden main page of the app
	    res.redirect('/index.html');
	});

app.get('/logout', function(req,res){
  req.logout();
  res.redirect('/');
});

// static files in /user are only available after login
app.get('/*',
	isAuthenticated, // only pass on to following function if
	// user is logged in 
	// serving files that start with /user from here gets them from ./
	express.static('user') 
       ); 



// next, put all queries (like store or reminder ... notice the isAuthenticated 
// middleware function; queries are only handled if the user is logged in
app.get('/query', isAuthenticated,
    function (req, res) { 
      console.log("saw query");
      res.send('HTTP query!') });

// This is where the server recieves and responds to get /all requests
// used for debugging - dumps whole database
app.get('/all',isAuthenticated, async function(request, response, next) {
  console.log("Server recieved a get /all request at", request.url);
  let results = await dbo.get_all()
  
  response.send(results);
});

// This is where the server recieves and responds to store POST requests
app.post('/store', isAuthenticated, async function(request, response, next) {
  console.log("Server recieved a post request at", request.url);


  request.body.userID = request.user.userid

  let activity = act.Activity(request.body)

  await dbo.post_activity(activity)

  let sql = "select * from ActivityTable";
  let table = await db.all(sql);

  console.log(table)




  
  response.send({ message: "I got your POST request"});
});

// This is where the server recieves and responds to  reminder GET requests
app.get('/reminder', isAuthenticated, async function(request, response, next) {
  console.log("Server recieved a post request at", request.url)
  
  let currTime = newUTCTime()
  currTime = (new Date()).getTime()

  let userid = request.user.userid;

  // Get Most Recent Past Planned Activity and Delete All Past Planned Activities
  let result = await dbo.get_most_recent_planned_activity_in_range(userid,0, currTime)
  //await dbo.delete_past_activities_in_range(userid,0, currTime);

  if (result != null){
    // Format Activity Object Properly
    result.scalar = result.amount
    result.date = result['MAX(date)']
    // Send Client Most Recent Planned Activity from the Past
    response.send(act.Activity(result));
  } else {
    response.send({message: 'All activities up to date!'});
  }
  
});


// This is where the server recieves and responds to week GET requests
app.get('/week', isAuthenticated, async function(request, response, next) {
  console.log("Server recieved a post request at", request.url);

  let date = parseInt(request.query.date)
  let activity = request.query.activity
  let userid = request.user.userid;
  
  /* Get Latest Activity in DB if not provided by query params */
  if (activity === undefined) {
    let result = await dbo.get_most_recent_entry(userid)
    try {
      activity = result.activity
    } catch(error) {
      activity = "none"
    }
  }
  
  /* Get Activity Data for current Date and The Week Prior */
  let min = date - 6 * MS_IN_DAY
  let max = date
  let result = await dbo.get_similar_activities_in_range(userid,activity, min, max)

  /* Store Activity amounts in Buckets, Ascending by Date */
  let data = Array.from({length: 7}, (_, i) => {
    return { date: date - i * MS_IN_DAY, value: 0 }
  })

  /* Fill Data Buckets With Activity Amounts */
  for(let i = 0 ; i < result.length; i++) {
    let idx = Math.floor((date - result[i].date)/MS_IN_DAY)
    data[idx].value += result[i].amount
  }
  
  // Send Client Activity for the Se;ected Week
  response.send(data.reverse());
});

app.get('/name', isAuthenticated,async function(req,res){
      console.log("Server received a request at url: ", req.url);
      console.log("name is: ", req.user);

      let userid = req.user.userid;

      let sql = "Select * from Profile where userID = ?";
      let prof = await db.get(sql, userid);

      console.log("profile is: " ,prof);
      res.send(prof);


    });


// finally, file not found, if we cannot handle otherwise.
app.use( fileNotFound );


/*
// listen for requests :)
const listener = app.listen(3000, () => {
  console.log("The static server is listening on port " + listener.address().port);
});
*/



// call the async test function for the database
// this fills the db with test data
// in your system, you can delete this. 
/*
dbo.testDB().catch(
  function (error) {
    console.log("error:",error);}
);
*/

// UNORGANIZED HELPER FUNCTIONS

const MS_IN_DAY = 86400000

/**
 * Convert GMT date to UTC
 * @returns {Date} current date, but converts GMT date to UTC date
 */
 function newUTCTime() {
    let gmtDate = new Date()
    let utcDate = (new Date(gmtDate.toLocaleDateString()))
    let utcTime = Date.UTC(
        utcDate.getFullYear(),
        utcDate.getMonth(),
        utcDate.getDay()
    )
    console.log("time:", utcTime)
    return utcTime
}



/**
 * Convert UTC date to UTC time
 * @param {Date} date - date to get UTC time of
 * @returns {number}
 */
function date_to_UTC_datetime(date) {
  let utcDate = new Date(date.toLocaleDateString())
  return Date.UTC(
        utcDate.getFullYear(),
        utcDate.getMonth(),
        utcDate.getDay()
    )
}


// Pipeline is ready. Start listening!  
const listener = app.listen(3000, () => {
  console.log("The static server is listening on port " + listener.address().port);
});


// middleware functions called by some of the functions above. 

// print the url of incoming HTTP request
function printURL (req, res, next) {
    console.log(req.url);
    next();
}

// function for end of server pipeline
function fileNotFound(req, res) {
    let url = req.url;
    res.type('text/plain');
    res.status(404);
    res.send('Cannot find '+url);
    }


// function to check whether user is logged when trying to access
// personal data
function isAuthenticated(req, res, next) {
    if (req.user) {
      // user field is filled in in request object
      // so user must be logged in! 
	    console.log("user",req.user,"is logged in");
	    next();
    } else {
	res.redirect('/splash.html');  // send response telling
	// Browser to go to login page
    }
}



// Some functions Passport calls, that we can use to specialize.
// This is where we get to write our own code, not just boilerplate. 
// The callback "done" at the end of each one resumes Passport's
// internal process.  It is kind of like "next" for Express. 

// function called during login, the second time passport.authenticate
// is called (in /auth/redirect/),
// once we actually have the profile data from Google. 
async function gotProfile(accessToken, refreshToken, profile, done) {
    console.log("Google profile has arrived",profile);
    // here is a good place to check if user is in DB,
    // and to store him in DB if not already there. 
    // Second arg to "done" will be passed into serializeUser,
    // should be key to get user out of database.
    console.log("Name is: ", profile.name.givenName);
    let userid = profile.id;  
    let firstname = profile.name.givenName;
    console.log("userid is: ", userid)
    const insertDB = "insert into Profile (userID, firstName) values (?,?)";
    const allDB = "select * from Profile";
    const sql = "select * from Profile where userID = ?"

    let table = await db.all(sql, userid)
    if(Object.keys(table).length === 0){
      console.log("Profile does not exist!")
      await db.run(insertDB, userid,firstname);
    }
    else{
      console.log("Profile exists!")
    }
    //await db.run(deleteDB)
    let result = await db.all(allDB);
    console.log("result is: ", result);

    done(null, userid); 
}



// Part of Server's sesssion set-up.  
// The second operand of "done" becomes the input to deserializeUser
// on every subsequent HTTP request with this session's cookie. 
passport.serializeUser((userid, done) => {
    console.log("SerializeUser. Input is",userid);
    done(null, userid);
});

// Called by passport.session pipeline stage on every HTTP request with
// a current session cookie. 
// Where we should lookup user database info. 
// Whatever we pass in the "done" callback becomes req.user
// and can be used by subsequent middleware.
passport.deserializeUser((userid, done) => {
    console.log("deserializeUser. Input is:", userid);

    let userData = {userid: userid};
    done(null, userData);

    // here is a good place to look up user data in database using
    // dbRowID. Put whatever you want into an object. It ends up
    // as the property "user" of the "req" object. 
    
});


