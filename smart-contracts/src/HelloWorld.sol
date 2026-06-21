// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract HelloWorld {
    string public message = "Hello, MedoxieChain!";

    event MessageUpdated(string previousMessage, string newMessage, address indexed author);

    function setMessage(string calldata newMessage) external {
        string memory previousMessage = message;
        message = newMessage;
        emit MessageUpdated(previousMessage, newMessage, msg.sender);
    }
}
