const { Client, GatewayIntentBits, Events } = require('discord.js');
const axios = require('axios');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const { Configuration, OpenAIApi } = require("openai");
const { TwitterApi } = require('twitter-api-v2');
const { PROMPT_REMEMBER, PROMPT_CONVO_EVALUATE_FOR_TWEET, PROMPT_CONVO_EVALUATE_INSTRUCTIONS, PROMPT_TWEET_REQUEST } = require('./prompts');
const chance = require('chance').Chance();

dotenv.config();

// set up the v2 twitter api so we can easily tweet from our account
// all the creds are in .env
const twitterClient = new TwitterApi(
  {
    // appKey: process.env.TWITTER_CONSUMER_KEY,
    // appSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  }
);


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // make sure we have the intent to get reactions
    GatewayIntentBits.GuildMessageReactions,
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_API_KEY
);

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Generate a response from the assistant
async function generateResponse(prompt, user) {
  // Retrieve user memory from Supabase
  //const memory = await getUserMemory(user.username);

  const memory = await assembleMemory(prompt, user)

  const messages = await getUserMessageHistory(user.username, 2)

  // console.log('A', memory)
  // Print a beautifully formatted memory to the console
  // console.log('🧠 Memory:', JSON.stringify(memory.map(mem => mem.value), null, 2))

  const promptMessages = [
    {
      role: "system",
      content: PROMPT_SYSTEM,
    },
    {
      role: "system",
      content: "The current date and time is: " + new Date().toLocaleString(),
    },
    ...messages.map(message => ({ role: "system", content: `Previously this user said: ${message.value.slice(0, 1000)}...` })),
    ...memory.map(mem => ({ role: "system", content: `${mem.value}` })),
    {
      role: "user",
      content: `${user.username}: ${prompt}`,
    },
  ]

  console.log('📝 Prompt:', JSON.stringify(promptMessages, null, 2))

  let response

  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-4",
      temperature: 0.75,
      presence_penalty: 0.4,
      // use gpt3.5 turbo
      // model: "gpt-3.5-turbo",
      // max 2000 tokens
      max_tokens: 1200,
      messages: promptMessages,
    });

    response = completion.data.choices[0].message
  }
  catch(error) {
    console.error('Error generating response:', error)

    // tell the channel there was an error
    return 'Sorry, I could not generate a response... there was an error.'
  }


  try {
    const rememberCompletion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      temperature: 0.25,
      max_tokens: 250,
      // frequency_penalty: -0.2,
      messages: [
        {
          role: "system",
          content: PROMPT_REMEMBER_INTRO,
        },
        {
          role: "system",
          content: PROMPT_REMEMBER(user)
        },
        {
          role: "user",
          content: prompt
        },
        // If we include the assistant's response, it ends up re-remembering things over and over
        // It would be nice to sometimes know what the robot said back when it was remembering, but it's not crucial
        // {
        //   role: "assistant",
        //   content: response.content
        // }
      ],
    });

    const rememberMessage = rememberCompletion.data.choices[0].message.content;

    return { response, rememberMessage };
  } catch (error) {
    console.error('Error generating response:', error);
    // tell the channel there was an error
    return 'Sorry, I am having trouble remembering this interaction... there was an error.';
  }
}

client.on('messageCreate', async function (message) {
  try {
    const botMentioned = message.mentions.has(client.user);

    if (!message.author.bot && botMentioned) {
      // send "bot is typing" to channel every 5000ms
      let typingInterval = setInterval(() => {
        message.channel.sendTyping();
      }, 5000);

      console.log(message.content);
      let prompt = message.content;

      if (prompt.includes('@coachartie')) {
        prompt = prompt.replace('@coachartie', '');
      }
    
      let { response, rememberMessage } = await generateResponse(prompt, message.author);

      // Clear typing interval and send response
      clearInterval(typingInterval);
      splitAndSendMessage(response, message);
      
      // Save the message to the database
      storeUserMessage(message.author.username, message.content);

      if (!isRememberResponseFalsy(rememberMessage)) {
        console.log(`🧠 Remembering... ${rememberMessage}`);

        // Save the memory to the database
        storeUserMemory(message.author.username, rememberMessage);
      }

      evaluateAndTweet(prompt, response.content, message.author, message);
    }

  } catch (error) {
    console.log(error);
  }
});

// Get all memories for a user
async function getUserMemory(userId, limit = 5) {
  console.log('💾 Querying database for memories... related to user:', userId);
  const { data, error } = await supabase
    .from('storage')
    .select('*')
    // limit to the last 50 memories
    .limit(limit)
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching user memory:', error);
    return null;
  }

  return data;
}

// get all memories (regardless of user)
async function getAllMemories(limit = 100) {
  console.log('💾 Querying database for memories...');
  const { data, error } = await supabase
    .from('storage')
    .select('*')
    .limit(limit);

  if (error) {
    console.error('Error fetching user memory:', error);
    return null;
  }

  return data;
}



// Get all memories for a search term
async function getSearchTermMemories(searchTerm, limit = 40) {
  const { data, error } = await supabase
    .from('storage')
    .select('*')
    // limit to the last 50 memories
    .limit(limit)
    .ilike('value', `%${searchTerm}%`);

  if (error) {
    console.error('Error fetching user memory:', error);
    return null;
  }

  return data;
}

// Get message history for a user
async function getUserMessageHistory(userId, limit = 5) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .limit(limit)
    // sort so we get the most recent messages first
    .order('created_at', { ascending: false })
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching user memory:', error);
    return null;
  }

  return data;
}


// Store a memory for a user
async function storeUserMemory(userId, value) {
  const { data, error } = await supabase
    .from('storage')
    .insert([
      {
        user_id: userId,
        value,
      },
    ]);

  if (error) {
    console.error('Error storing user memory:', error);
  }
}

// Store a message from a user
async function storeUserMessage(userId, value) {
  const { data, error } = await supabase
    .from('messages')
    .insert([
      {
        user_id: userId,
        value,
      },
    ]);

  if (error) {
    console.error('Error storing user message:', error);
  }
}

// Get a random N number of memories
async function getRandomMemories(numberOfMemories) {
  // const memories = await getUserMemory(userId);
  const memories = await getAllMemories();

  if(!memories) {
    console.error('Error getting random memories')
    return [];
  }
  if (memories && memories.length > 0) {
    const randomMemories = chance.pickset(memories, numberOfMemories);
    return randomMemories//.map(memory => memory.value);
  }

  return [];
}

function splitAndSendMessage(message, messageObject) {
  // refactor so that if the message is longer than 2000, it will send multiple messages
  if(!message) messageObject.channel.send(`I am so sorry, there was some sort of problem...`)

  if (message.length < 2000) {
    messageObject.channel.send(message);
  }
  else {
    let responseArray = message.content.split(" ");
    let responseString = "";
    for (let i = 0; i < responseArray.length; i++) {
      if (responseString.length + responseArray[i].length < 2000) {
        responseString += responseArray[i] + " ";
      }
      else {
        messageObject.channel.send(responseString);
        responseString = responseArray[i] + " ";
      }
    }
    messageObject.channel.send(responseString);
  }
}

// Interpret the response when we ask the robot "should we remember this?"
function isRememberResponseFalsy(response) {
  const lowerCaseResponse = response.toLocaleLowerCase();

  // is the string 'no.' or 'no'?
  if (lowerCaseResponse === 'no' || lowerCaseResponse === 'no.') {
    return true;
  }

  // does the string contain 'no crucial' or 'no important'?
  if (lowerCaseResponse.includes('no crucial') || lowerCaseResponse.includes('no important')) {
    return true;
  }

  // does the string contain 'no key details'?
  if (lowerCaseResponse.includes('no key details')) {
    return true;
  }

}

// Given a message, return the last 5 memories and the last 5 messages
async function assembleMemory(message, user) {
  // Get the last X memories for the current user
  const memories = await getUserMemory(user.username, 5);

  // get X random memories
  const randomMemories = await getRandomMemories(25);

  // Concat the memories and messages
  const memory = [...new Set([
    ...memories//.map(mem => mem.value)
    ,
    ...randomMemories])];

  return memory;
}

// use twitterClient to tweet and return the URL of the tweet
async function tweet(tweetText) {
  try {
    return await twitterClient.v2.tweet(tweetText)
    // this returns error 401 unauthorized
  } catch (error) {
    console.log('🐦 Twitter error:', error)
    return error
  }
}

// Compose a tweet based on an exchange between a user and an assistant
async function composeTweet(prompt, response, user) {
  console.log('✍️ Composing tweet...')

  const memory = await getUserMemory(user);

  // const importantMemories = memory.filter(mem => {
  //   // if the memory beings with "Remember forever: " then it's important
  //   if (mem.startsWith('Remember forever: ')) {
  //     return true
  //   }
  // })

  try {
    // Send the prompt and response to gpt3.5
    // and ask it to return a tweet
    const completion = await openai.createChatCompletion({
      // model: "gpt-4",
      model: "gpt-3.5-turbo",
      max_tokens: 320,
      temperature: 0.88,
      presence_penalty: 0.1,
      frequency_penalty: 0.14,
      messages: [
        {
          role: "system",
          content: PROMPT_TWEET_INTRO
        },
        // ...importantMemories.map(mem => ({ role: "system", content: `${mem.value}` })),
        {
          role: "assistant",
          content: "uwu U.S. Presidents with facial 𝕌w𝕌 hair?? We stan Chester A. Arthur 💗 a real 𝓂𝓊𝓈𝓉𝒶𝒸𝒽𝑒 𝒹𝒶𝒹𝒹𝓎 right there 🍂╰(◡‿◡✿╰)"
        },
        {
          role: "user",
          content: "Wow, that is great! Definitely tweet that! Love the playful tone and emojis and how short it is. Thank you for not using hashtags.",
        },
        {
          role: "assistant",
          content: "EJ and Jeff are asking me to write an essay about the history of facial hair in U.S. Presidents. I'm not sure I can do it, but I'll try my best! lmfao",
        },
        {
          role: "user",
          content: "Great tweet! I like how you gave an update about what we are doing. Thank you for not using hashtags.",
        },
        {
          role: "system",
          content: "Write a tweet about the following exchange - if the exchange contains a great tweet by itself, you can just use that: ",
        },
        {
          role: "user",
          content: prompt,
        },
        {
          role: "assistant",
          content: response,
        },
                {
          role: "system",
          content: PROMPT_TWEET_END,
        },
      ],
    });

    const tweet = completion.data.choices[0].message.content

    // remove any hashtag words from the tweet
    const tweetWithoutHashtags = tweet.replace(/#\w+/g, '')    

    console.log('\n\n🐦 Tweet:', tweet)

    // return tweet;
    return tweetWithoutHashtags;
  }
  catch (error) {
    console.log('🐦 Error composing tweet:', error)
    return error
  }

}

// Create a function that we will call randomly
// It will evaluate the content of an exchange between a user and the robot
// and decide whether it is cool enough to tweet
// if it is cool enough to tweet, it sends a message to the channel asking if it should tweet it
// and if the user says yes, it tweets it
async function evaluateAndTweet(prompt, response, user, message) {
  console.log('🤖 Evaluating exchange to determine tweet...')
  // Send the prompt and response to gpt3.5

  // console.log stringified versions of all the args
  // console.log('prompt:', JSON.stringify(prompt))
  // console.log('response:', JSON.stringify(response))
  // console.log('user:', JSON.stringify(user))

  // wait a few seconds
  // so that the user has time to read the response
  // and we don't hammer the API
  // we will await a promise resolving after a random number of milliseconds
  await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 2000));

  // and ask it to return a score of how cool it thinks the exchange is
  const completion = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    max_tokens: 10,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: PROMPT_CONVO_EVALUATE_FOR_TWEET,
      },      
      {
        role: "system",
        content: "\n NEW SESSION \n"
      },
      {
        role: "user",
        content: prompt,
      },
      {
        role: "assistant",
        content: response,
      },
      {
        role: "user",
        content: PROMPT_CONVO_EVALUATE_INSTRUCTIONS,
      }
    ],
  });

  let tweetEvaluation = completion.data.choices[0].message

  console.log('🤖 Tweet evaluation, pre-process:', tweetEvaluation)

  // get the content out of the message
  tweetEvaluation = tweetEvaluation.content

  // let tweetEvaluation = 50

  // If the score is high enough, tweet it
  if (+tweetEvaluation >= 70) {
    console.log('🤖 I think this exchange is cool enough to tweet. Let me ask...')

    // set the time to collect reactions
    const collectionTimeMs = 60000


    // Use openAI to write a message to the channel asking for permission to tweet the exchange
    const tweetRequestCompletion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      max_tokens: 300,
      temperature: 1,
      messages: [
        {
          role: "system",
          content: "The current date and time is: " + new Date().toLocaleString(),
        },
        {
          role: "system",
          content: PROMPT_TWEET_REQUEST(tweetEvaluation, collectionTimeMs),
        // write a user prompt that will inspire the assistant to respond with a message asking if the exchange should be tweeted
        {
          role: "user",
          content: "tweet request"
        },
        {
          role: "assistant",
          content: `Can I tweet this out?
  (**${tweetEvaluation}** / 100) 
  React within ${collectionTimeMs / 1000}s to approve.`
        },
        {
          role: "user",
          content: "tweet request"
        },
        {
          role: "assistant",
          content: `I like this tweet!  (My internal evaluation gave it ${tweetEvaluation}/100) Can I tweet it please? 
  
  If so, add a 🐦 reaction within ${collectionTimeMs / 1000} seconds to approve.`
        },
        {
          role: "user",
          content: "tweet request"
        },
        {
          role: "assistant",
          content: `Let me tweet that shit! Put a 🐦 reaction on this message within ${collectionTimeMs / 1000} seconds to approve, plleaaaase! 🥺`
        },
        {
          role: "user",
          content: "tweet request"
        },
      ],
    });

    // get the content out of the message
    let tweetRequest = tweetRequestCompletion.data.choices[0].message.content

    // send the tweet request to the channel
    message.channel.send(tweetRequest)
      .then((tweetQMsg) => {
        // add twitter emoji reaction so users don't have to search for it
        tweetQMsg.react('🐦')

        // Create a filter for reactions to the message
        const filter = (reaction, user) => {
          // We could filter to certain emojis and certain users
          // return ['🐦'].includes(reaction.emoji.name) && user.username === message.author.username;
          return true
        }

        let tweetStarted = false
        // create a reaction collector
        const collector = tweetQMsg.createReactionCollector(filter, { time: collectionTimeMs });

        // When we see a new reaction...
        collector.on('collect', async (reaction, user) => {
          if (tweetStarted) return
          // If the user who did the reaction is a bot, ignore it
          if (user.bot) return

          // console.log('🤖 Someone reacted to the message!')
          message.channel.send(`${user} approved a tweet! Let me think of something...`)

          tweetStarted = true

          // Compose a tweet and tweet it 
          const tweetText = await composeTweet(prompt, response, user)

          message.channel.send(`🕊️ Tweeting: ${tweetText}`)

          // Tweet it out and then send a link to the tweet to the channel
          try {
            const twitterResponse = tweet(tweetText).then((twitterResponse) => {
              console.log('twitter tweet response', twitterResponse)
              // get the link to the tweet

              // send the stringified twitter response to the channel
              // message.channel.send(`🐦 Twitter response: 
              // \`\`\`${JSON.stringify(twitterResponse)}
              // \`\`\`
              // `)

              // tell the channel that this is where we would tweet the URL if Elon Musk wasn't a huge piece of shit
              // message.channel.send(`This is where I would drop in the URL for the tweet if Elon Musk wasn't a huge piece of human shit.`)
              message.channel.send(`Twitter API access currently disabled.`)

            })
          } catch (error) {
            console.log('🐦 Twitter error:', error)

            // send the error to the channel
            message.channel.send(`🐦 Twitter error: ${error}`)
          }
        })

        // collector.on('end', collected => {
        //   console.log(`Collected ${collected.size} reactions`);
        //   // Send a message to the channel with the JSON of the reaction
        //   message.channel.send(`Collected ${collected.size} reactions`)

        //   // delete the tweetQMsg
        //   // tweetQMsg.delete()
        // })
      })
  }
}

client.once(Events.ClientReady, c => {
  // Log when we are logged in
  console.log(`⭐️ Ready! Logged in as ${c.user.username}`);

  // Log any of the guilds/servers the bot is in
  client.guilds.cache.forEach((guild) => {
    console.log(guild.name);
    // List all channels
    // guild.channels.cache.forEach((channel) => {
    //   console.log(` - ${channel.name} (${channel.type}) - ${channel.id}`);
    // });
  });
});

client.on(Events.InteractionCreate, interaction => {
  // Log every interaction we see
  console.log(interaction);
});

client.on('message', message => {
  console.log(`Message received: ${message.content}`);
  console.log(`From: ${message.author.username}`);
  console.log(`Channel ID: ${message.channel.id}`);
});


client.on('debug', info => {
  console.log(`Debug info: ${info}`);
});

client.on('error', error => {
  console.error(`Client error: ${error}`);
});

// An async function to send a message to a channel
// for the entire duration of the program
// This is used to send a typing indicator
// to the discord channel
async function sendTypingIndication(channel) {
  while (true) {
    channel.sendTyping();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}


client.login(process.env.DISCORD_BOT_TOKEN);