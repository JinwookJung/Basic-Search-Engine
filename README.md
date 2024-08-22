# Basic Web Search Engine

The Basic Web Search Engine uses web crawler Node.js module to collect data through all the links on Wikipedia pages starting with a seed web page (https://en.wikipedia.org/). While web crawler running, it saves all data from the websites into MongoDB database. Once the web crawler scraps the data from 750 websites, it automatically stop crawling.

After crawling stops, the Search Engine will show search result. You can choose boosting the search score with PageRank score or not.

## Requirements (required)

This application requires the following modules:

- Node.js v19.6.0
- MongoDB v7

## Installation

To install Node.js
follow instruction on https://nodejs.org/en/download/package-manager

To install MongoDB
follow instruction on https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-os-x/

To install all modules needed to run the application:
`npm i`

## How to run the application

1. Make sure MongoDB instance is running (Or crawler cannot save data in MongoDB)
2. Run "database-init.js" to initialize MongoDB database using this command:
   `node database-init.js`
3. Start a application with a command:
   `npm start`
4. open a web browser of your choice and type `http://localhost:3000/` on the address bar. Then the Web Crawler automatically starts. You can see the status on your terminal. Please wait until crawling stops.

5. Click Search Wiki Pages link and type Search Query in then if you click Search Query button, the result will show on the next page in descending order based on the Search Score. But if you choose the second option "Boost using PageRank score" true, You will see different result that PageRank score used.
