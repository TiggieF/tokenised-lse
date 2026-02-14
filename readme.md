terminal one
cd /Users/tigerfang/Desktop/tokenised-lse
npm run dev:chain

terminal 2
cd /Users/tigerfang/Desktop/tokenised-lse/scripts/ui
npm run dev

and check if theres a chain running already
lsof -i :8545
kill -9 pid