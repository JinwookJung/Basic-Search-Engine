//EXPRESS SERVER --------------------------------------------------------------------- 
const express = require('express');
const app = express();
const pug = require('pug');
const path = require('path');
const PORT = process.env.PORT || 3000;
const mc = require("mongodb").MongoClient;
const mongoURL = 'mongodb://127.0.0.1:27017';
const Crawler = require("crawler");
const { MongoClient, ObjectID } = require("mongodb");
const { Matrix } = require("ml-matrix");
const elasticlunr = require("elasticlunr");
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

//MIDDLEWARE SEQUENCE ----------------------------------------------------------------
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//connect to the database
async function connectToDatabase() {
    try {
        const client = await MongoClient.connect("mongodb://127.0.0.1:27017");
        const db = client.db('A1');
        // console.log("Connected to database.");
        return { client, db };
    } catch (err) {
        console.error("Failed to connect to database.", err);
        throw err;
    }
}

//close the database connection
async function closeDatabaseConnection(client) {
    try {
        await client.close();
        // console.log("Database connection closed.");
    } catch (err) {
        console.error("Failed to close database connection.", err);
        throw err;
    }
}

//function to compute the page rank
async function computeAdjacencyMatrix() {
    const { client, db } = await connectToDatabase();
    const pages = await db.collection('pages').find().toArray();
    closeDatabaseConnection(client);
    const pageIndices = {};
    const matrix = Array(pages.length).fill(0).map(row => Array(pages.length).fill(0));
    pages.forEach((page, index) => {
        pageIndices[page.href] = index;
    });
    pages.forEach(page => {
        const pageIndex = pageIndices[page.href];
        page.linksTo.forEach(link => {
            const linkedPageIndex = pageIndices[link];
            if (linkedPageIndex !== undefined) {
                matrix[pageIndex][linkedPageIndex] = 1;
            }
        });
    });
    // console.log(matrix);
    return matrix;
}

function computePageRankFromAdjMatrix(matrix) {
    const alpha = 0.1;
    const numberOfPages = matrix.length;
    let rank = Array(numberOfPages).fill(1.0 / numberOfPages);
    let prevRank = Array(numberOfPages).fill(0);
    const L1Difference = (v1, v2) => { return v1.reduce((sum, a, idx) => sum + Math.abs(a - v2[idx]), 0); };
    while (L1Difference(rank, prevRank) > 0.0001) {
        prevRank = [...rank];
        for (let i = 0; i < numberOfPages; i++) {
            let sum = 0;
            for (let j = 0; j < numberOfPages; j++) {
                if (matrix[j][i] === 1) {
                    const outLinks = matrix[j].reduce((acc, val) => acc + val, 0);
                    sum += prevRank[j] / outLinks;
                }
            }
            rank[i] = alpha / numberOfPages + (1 - alpha) * sum;
        }
    }
    // console.log(rank);
    return rank;
}

const convertArrayToObject = (array, key) => {
    const initialValue = {};
    return array.reduce((obj, item) => {
        return {
            ...obj,
            [item[key]]: item,
        };
    }, initialValue);
};


//CRAWLER ----------------------------------------------------------------------------
const visitedURLs = new Set();

const c = new Crawler({
    maxConnections: 10,
    jQuery: true,
    // rateLimit: 1000, 
    // retries: 3, 
    // retryTimeout: 5000,

    //This will be called for each crawled page
    callback: function (error, res, done) {
        if (error) {
            console.log(error);
        }

        if (res.$) {
            const currentURL = res.request.uri.href;

            let $ = res.$;
            const linkedTo = [];
            const title = $("title").text();
            const anchorTexts = $("a").map(function () { return $(this).text(); }).get().join(', ');
            const paragraphText = $("p").text();
            const bodyText = $("body").text();

            let links = $("a")
            $(links).each(function (i, link) {
                const href = $(link).attr('href');
                const fullURL = new URL(href, res.request.uri.href).toString();
                linkedTo.push(fullURL);
                if (!visitedURLs.has(fullURL)) {
                    visitedURLs.add(fullURL);
                    c.queue(fullURL);
                }
            });

            //save pages only ending with .html
            if (currentURL.endsWith(".html")) {
                //Save page contents
                (async function savePages() {
                    const { client, db } = await connectToDatabase();

                    //Store the content from each page within a database.
                    await db.collection("pages").insertOne({
                        title: title,
                        href: res.request.uri.href,
                        a: anchorTexts,
                        p: paragraphText,
                        body: bodyText,
                        //outgoing links from this page
                        linksTo: linkedTo,
                    });
                    closeDatabaseConnection(client);
                })();
            }
        }
        done();
    }
});

c.on('drain', function () {
    console.log("Done.");
    console.log(visitedURLs.size);

    // //perform PageRank after crawling is done
    // (async function getPageRank() {
    //     const adjMatrixData = await computeAdjacencyMatrix();
    //     const pageRankResults = computePageRankFromAdjMatrix(adjMatrixData);
    //     const { client, db } = await connectToDatabase();
    //     const pages = await db.collection('pages').find().toArray();
    //     closeDatabaseConnection(client);
    //     const rankedPages = pages.map((page, index) => ({
    //         url: page.href,
    //         rank: pageRankResults[index]
    //     }));
    //     rankedPages.sort((a, b) => b.rank - a.rank);
    //     rankedPages.slice(0, 25).forEach((page, index) => {
    //         console.log(`#${index + 1}. (${page.rank.toFixed(10)}) ${page.url}`);
    //     });
    // })();

});

console.log("Start Crawling...");
//Queue a URL, which starts the crawl
c.queue('https://people.scs.carleton.ca/~davidmckenney/fruitgraph/N-0.html');

//ROUTE------------------------------------------------------------------------------------------
//index page
app.get('/', (req, res) => {
    res.send(pug.renderFile("./views/index.pug"));
});
//fruits search page
app.get('/fruitsSearch', (req, res) => {
    res.send(pug.renderFile("./views/fruitsSearch.pug"));
});

//fruits result page
//fruits?q=banana&boost=true&limit=10
app.get('/fruits', (req, res) => {
    
    let { q, boost, limit } = req.query;

    boost = (boost === 'true');
    limit = parseInt(limit);


    //boost == false, not using PageRank score
    if (!boost) {
        //indexing
        const index = elasticlunr(function () {
            this.addField('title');
            this.addField('p');
            this.addField('a');
            this.setRef('mongo_id');
        });

        //add the index with data from MongoDB
        (async function populateElasticlunrIndex() {
            const { client, db } = await connectToDatabase();
            await db.collection("pages").find().forEach((page) => {
                index.addDoc({ mongo_id: page._id, title: page.title, p: page.p, a: page.a });
            });
            const refAndSearchScores = index.search(q, {}).slice(0, limit);
            // console.log(refAndSearchScores);
            // console.log(results);
            let pagesToClient = [];

            //find the page with the given title 
            const pages = await db.collection('pages').find().toArray();
            pages.forEach((page) => {
                refAndSearchScores.forEach((refAndSearchScore) => {
                    if (page._id == refAndSearchScore.ref) {
                        let pageDetails = {};
                        pageDetails = { ...page };
                        pageDetails.score = refAndSearchScore.score;//add Search Score
                        pagesToClient.push(pageDetails);
                    }
                })
            });


            // refAndSearchScores.forEach(async (refAndSearchScore) => {
            //     const page = await db.collection('pages').findOne({ _id: ObjectID(refAndSearchScore.ref) })
            //         .then((page) => {

            //         });

            // //get PageRank score
            // const adjMatrixData = await computeAdjacencyMatrix();
            // const pageRankResults = computePageRankFromAdjMatrix(adjMatrixData);
            // console.log(pageRankResults);

            // const pages = await db.collection('pages').find().toArray();
            // const rankedPages = pages.map((page, index) => ({
            //     url: page.href,
            //     rank: pageRankResults[index]
            // }));

            // // console.log(rankedPages);

            // pagesToClient.forEach((page) => {
            //     if (page.href.localeCompare(rankedPages.url))
            //         page.rank = rankedPages.rank;
            // });

            // // console.log(pagesToClient);

            if (pagesToClient.length === limit) {
                pagesToClient.sort((a, b) => b.score - a.score);
                closeDatabaseConnection(client);
                // console.log(pagesToClient);

                //Response to text/html request
                if (req.accepts(`text/html`)) {
                    res.send(pug.renderFile("./views/fruitsResult.pug", {
                        results: pagesToClient
                    }));
                    return;
                }

                //Response to json request
                if (req.accepts(`application/JSON`)) {
                    //add group member name
                    for (const page of pagesToClient) {
                        //add name
                        page.name = `Allan Wang, Saad Qamar, Jinwook Jung`;

                        //remove key and value that doesn't need  
                        delete page.a;
                        delete page.p;
                        delete page.linksTo;
                        delete page.body;
                        delete page._id;

                        //change key "href" to "url"
                        page['url'] = page.href;
                        delete page.href;
                    }
                    //convert js Array to object
                    const objFromArray = {};
                    pagesToClient.forEach((item, index) => {
                        objFromArray[`${index + 1}`] = item;
                    });
                    // console.log(objFromArray);
                    res.json(JSON.stringify(objFromArray));
                    return;
                }
            }
        })();
    }
});

//represents a request to search the data from the fruit example
app.get('/personal', (req, res) => {

});